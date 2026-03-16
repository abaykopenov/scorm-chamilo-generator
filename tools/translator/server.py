import os
import json
import requests as http_requests
from flask import Flask, request, jsonify
import argostranslate.package
import argostranslate.translate

app = Flask(__name__)

OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434")
OLLAMA_MODEL = os.environ.get("OLLAMA_TRANSLATE_MODEL", "qwen2.5:14b")

_packages_synced = False
_unavailable_pairs = set()  # Cache of known unavailable pairs

LANG_NAMES = {
    "ru": "русский",
    "en": "английский", 
    "kk": "казахский",
    "uk": "украинский",
    "de": "немецкий",
    "fr": "французский",
    "es": "испанский",
    "zh": "китайский",
    "ar": "арабский",
    "tr": "турецкий",
    "uz": "узбекский",
}

def ensure_package_index():
    global _packages_synced
    if not _packages_synced:
        try:
            argostranslate.package.update_package_index()
            _packages_synced = True
        except Exception as e:
            print(f"Warning: Could not update package index: {e}")

def is_package_installed(from_code, to_code):
    installed = argostranslate.package.get_installed_packages()
    return any(pkg.from_code == from_code and pkg.to_code == to_code for pkg in installed)

def is_package_available(from_code, to_code):
    pair = (from_code, to_code)
    if pair in _unavailable_pairs:
        return False
    ensure_package_index()
    available = argostranslate.package.get_available_packages()
    found = any(p.from_code == from_code and p.to_code == to_code for p in available)
    if not found:
        _unavailable_pairs.add(pair)
    return found

def install_package(from_code, to_code):
    if is_package_installed(from_code, to_code):
        return True
    if not is_package_available(from_code, to_code):
        return False
    
    ensure_package_index()
    available_packages = argostranslate.package.get_available_packages()
    package_to_install = next(
        (x for x in available_packages if x.from_code == from_code and x.to_code == to_code), None
    )
    if package_to_install:
        print(f"Downloading Argos package: {from_code} -> {to_code}...")
        argostranslate.package.install_from_path(package_to_install.download())
        print(f"Installed {from_code} -> {to_code}")
        return True
    return False

def can_argos_translate(source, target):
    """Check if Argos can translate directly or via English pivot."""
    if is_package_available(source, target):
        return True
    if source != "en" and target != "en":
        return is_package_available(source, "en") and is_package_available("en", target)
    return False

def argos_translate_text(text, source, target):
    """Translate via Argos, with English pivot if needed."""
    if not text or not str(text).strip():
        return text
    
    text = str(text)
    
    # Direct translation?
    if is_package_available(source, target):
        install_package(source, target)
        return argostranslate.translate.translate(text, source, target)
    
    # Via English pivot
    if source != "en" and target != "en":
        if is_package_available(source, "en") and is_package_available("en", target):
            install_package(source, "en")
            install_package("en", target)
            intermediate = argostranslate.translate.translate(text, source, "en")
            return argostranslate.translate.translate(intermediate, "en", target)
    
    return text  # Fallback

# ─── Ollama LLM fallback ─────────────────────────────────────────────

def ollama_translate_batch(texts, source, target):
    """Use Ollama LLM to translate a batch of texts."""
    source_name = LANG_NAMES.get(source, source)
    target_name = LANG_NAMES.get(target, target)
    
    # Build a single prompt with all texts numbered
    numbered = "\n".join(f"{i+1}. {t}" for i, t in enumerate(texts))
    
    prompt = f"""Translate the following texts from {source_name} to {target_name}.
Return ONLY a JSON array of translated strings, no explanations.
Keep the same order and count. If a text is empty, keep it empty.

Texts to translate:
{numbered}

Respond with a JSON array like: ["translated1", "translated2", ...]"""

    try:
        resp = http_requests.post(
            f"{OLLAMA_URL}/api/chat",
            json={
                "model": OLLAMA_MODEL,
                "messages": [
                    {"role": "system", "content": f"You are a professional translator from {source_name} to {target_name}. Respond ONLY with a valid JSON array of translated strings."},
                    {"role": "user", "content": prompt}
                ],
                "stream": False,
                "options": {"temperature": 0.1}
            },
            timeout=120
        )
        
        if resp.status_code != 200:
            print(f"[Ollama] API error: {resp.status_code}")
            return texts
        
        data = resp.json()
        content = data.get("message", {}).get("content", "")
        
        # Extract JSON array from response
        content = content.strip()
        # Find the JSON array in the response
        start = content.find("[")
        end = content.rfind("]")
        if start != -1 and end != -1:
            json_str = content[start:end+1]
            translated = json.loads(json_str)
            if isinstance(translated, list) and len(translated) == len(texts):
                return translated
            elif isinstance(translated, list) and len(translated) > 0:
                # Pad or trim to match
                while len(translated) < len(texts):
                    translated.append(texts[len(translated)])
                return translated[:len(texts)]
        
        print(f"[Ollama] Could not parse response: {content[:200]}")
        return texts
        
    except Exception as e:
        print(f"[Ollama] Translation error: {e}")
        return texts

# ─── Flask routes ─────────────────────────────────────────────────────

@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok"})

@app.route("/languages", methods=["GET"])
def languages():
    ensure_package_index()
    available = argostranslate.package.get_available_packages()
    pairs = [{"from": p.from_code, "to": p.to_code} for p in available]
    return jsonify({
        "argos_pairs": pairs,
        "ollama_fallback": True,
        "ollama_model": OLLAMA_MODEL,
        "note": "Languages not in argos_pairs will use Ollama LLM for translation"
    })

@app.route("/translate", methods=["POST"])
def translate_api():
    data = request.json
    if not data or "q" not in data or "source" not in data or "target" not in data:
        return jsonify({"error": "Missing parameters (q, source, target)"}), 400
        
    source_lang = data["source"]
    target_lang = data["target"]
    texts = data["q"]
    
    if not isinstance(texts, list):
        texts = [texts]
        
    if source_lang == target_lang:
        return jsonify({"translatedText": texts})

    # Check if Argos can handle this pair
    use_argos = can_argos_translate(source_lang, target_lang)
    
    try:
        if use_argos:
            # Use Argos (fast, offline)
            translated = [argos_translate_text(t, source_lang, target_lang) for t in texts]
            return jsonify({"translatedText": translated, "engine": "argos"})
        else:
            # Fallback to Ollama LLM
            print(f"[Ollama] Using LLM fallback for {source_lang} -> {target_lang} ({len(texts)} texts)")
            
            # Batch translate in chunks of 10 for better reliability
            CHUNK_SIZE = 10
            translated = []
            for i in range(0, len(texts), CHUNK_SIZE):
                chunk = texts[i:i+CHUNK_SIZE]
                chunk_translated = ollama_translate_batch(chunk, source_lang, target_lang)
                translated.extend(chunk_translated)
            
            return jsonify({"translatedText": translated, "engine": "ollama"})
    except Exception as e:
        print(f"Translation error: {e}")
        return jsonify({"error": str(e)}), 500

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5005))
    
    print("Checking available Argos language packages...")
    ensure_package_index()
    
    # Pre-install common Argos packages
    for from_code, to_code in [("ru", "en"), ("en", "ru")]:
        install_package(from_code, to_code)
    
    print(f"Ollama fallback configured: {OLLAMA_URL} model={OLLAMA_MODEL}")
    print(f"Argos Translation Server starting on port {port}...")
    app.run(host="127.0.0.1", port=port, debug=False)
