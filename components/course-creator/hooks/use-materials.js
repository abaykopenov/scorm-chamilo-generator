import { useState, useCallback } from "react";
import { resolveErrorMessage } from "../utils";
import { 
  MATERIAL_CHUNKS_PAGE_SIZE, 
  MATERIAL_CHUNK_PREVIEW_CHARS,
  MAX_UPLOAD_FILES,
  MAX_UPLOAD_FILE_SIZE
} from "../constants";

export function useMaterials(initialSelectedIds = []) {
  const [materials, setMaterials] = useState([]);
  const [selectedMaterialIds, setSelectedMaterialIds] = useState(initialSelectedIds);
  const [selectedFiles, setSelectedFiles] = useState([]);
  const [expandedMaterialId, setExpandedMaterialId] = useState("");
  const [materialChunksState, setMaterialChunksState] = useState({});
  const [materialsMessage, setMaterialsMessage] = useState("");
  const [qdrantStatus, setQdrantStatus] = useState({
    loading: true,
    ok: false,
    mode: "fallback",
    message: "Checking Qdrant...",
    checkedAt: "",
    target: null
  });

  const checkQdrantStatus = useCallback(async () => {
    setQdrantStatus((current) => ({ ...current, loading: true }));
    try {
      const response = await fetch("/api/diagnostics/qdrant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({})
      });
      const payload = await response.json().catch(() => ({}));
      setQdrantStatus({
        loading: false,
        ok: Boolean(payload?.ok),
        mode: payload?.mode === "connected" ? "connected" : "fallback",
        message: payload?.message || (payload?.ok ? "Qdrant connected." : "Local vector fallback is active."),
        checkedAt: `${payload?.checkedAt || ""}`.trim(),
        target: payload?.target || null
      });
    } catch (error) {
      setQdrantStatus({
        loading: false,
        ok: false,
        mode: "fallback",
        message: resolveErrorMessage(error, "Qdrant check failed. Local vector fallback is active."),
        checkedAt: new Date().toISOString(),
        target: null
      });
    }
  }, []);

  const refreshMaterials = useCallback(async () => {
    try {
      const response = await fetch("/api/materials");
      if (!response.ok) throw new Error("Не удалось получить список материалов.");
      const payload = await response.json();
      const items = Array.isArray(payload?.materials) ? payload.materials : [];
      setMaterials(items);
      setSelectedMaterialIds((current) => current.filter((id) => items.some((item) => item.id === id)));
      setMaterialChunksState((current) => {
        const allowedIds = new Set(items.map((item) => item.id));
        const next = {};
        for (const [materialId, state] of Object.entries(current)) {
          if (allowedIds.has(materialId)) next[materialId] = state;
        }
        return next;
      });
      setExpandedMaterialId((current) => (items.some((item) => item.id === current) ? current : ""));
      return items;
    } catch (error) {
      throw new Error(resolveErrorMessage(error, "Ошибка загрузки списка материалов."));
    }
  }, []);

  const loadMaterialChunks = useCallback(async (materialId, options = {}) => {
    const append = Boolean(options?.append);
    const current = materialChunksState[materialId];
    const offset = append ? (current?.items?.length || 0) : 0;

    setMaterialChunksState((state) => ({
      ...state,
      [materialId]: {
        ...(state[materialId] || { items: [], total: 0, hasMore: false }),
        loading: true,
        error: ""
      }
    }));

    try {
      const params = new URLSearchParams({
        offset: String(offset),
        limit: String(MATERIAL_CHUNKS_PAGE_SIZE),
        previewChars: String(MATERIAL_CHUNK_PREVIEW_CHARS)
      });
      const response = await fetch("/api/materials/" + materialId + "/chunks?" + params.toString());
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.message || "Failed to load material chunks.");

      const incoming = Array.isArray(payload?.chunks) ? payload.chunks : [];
      const total = Number(payload?.pagination?.total) || incoming.length;
      const hasMore = Boolean(payload?.pagination?.hasMore);

      setMaterialChunksState((state) => {
        const previous = state[materialId] || { items: [] };
        const items = append ? [...(previous.items || []), ...incoming] : incoming;
        return {
          ...state,
          [materialId]: { loading: false, error: "", items, total, hasMore }
        };
      });
    } catch (error) {
      setMaterialChunksState((state) => ({
        ...state,
        [materialId]: {
          ...(state[materialId] || { items: [], total: 0, hasMore: false }),
          loading: false,
          error: resolveErrorMessage(error, "Failed to load chunks.")
        }
      }));
    }
  }, [materialChunksState]);

  const toggleMaterialChunks = useCallback((materialId) => {
    if (expandedMaterialId === materialId) {
      setExpandedMaterialId("");
      return;
    }
    setExpandedMaterialId(materialId);
    const current = materialChunksState[materialId];
    if (!current || (current.items || []).length === 0) {
      loadMaterialChunks(materialId).catch(() => {});
    }
  }, [expandedMaterialId, materialChunksState, loadMaterialChunks]);

  const toggleMaterialSelection = useCallback((materialId) => {
    setSelectedMaterialIds((current) => {
      if (current.includes(materialId)) return current.filter((id) => id !== materialId);
      return [...current, materialId];
    });
  }, []);

  return {
    materials,
    selectedMaterialIds,
    setSelectedMaterialIds,
    selectedFiles,
    setSelectedFiles,
    expandedMaterialId,
    setExpandedMaterialId,
    materialChunksState,
    setMaterialChunksState,
    materialsMessage,
    setMaterialsMessage,
    qdrantStatus,
    refreshMaterials,
    checkQdrantStatus,
    loadMaterialChunks,
    toggleMaterialChunks,
    toggleMaterialSelection
  };
}
