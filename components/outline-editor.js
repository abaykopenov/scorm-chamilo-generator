"use client";

import { useState } from "react";

export function OutlineEditor({ outline, onChange, onCancel, onConfirm }) {
  // Maintain a local deep copy of the outline for editing without mutating parent state immediately
  const [localOutline, setLocalOutline] = useState(() => JSON.parse(JSON.stringify(outline)));

  const updateTitle = (type, path, newTitle) => {
    setLocalOutline((prev) => {
      const next = { ...prev };
      let target = next;
      
      if (type === "module") {
        next.modules[path.moduleIndex].title = newTitle;
      } else if (type === "section") {
        next.modules[path.moduleIndex].sections[path.sectionIndex].title = newTitle;
      } else if (type === "sco") {
        next.modules[path.moduleIndex].sections[path.sectionIndex].scos[path.scoIndex].title = newTitle;
      } else if (type === "screen") {
        next.modules[path.moduleIndex].sections[path.sectionIndex].scos[path.scoIndex].screens[path.screenIndex].title = newTitle;
      }
      
      return next;
    });
  };

  const removeNode = (type, path) => {
    setLocalOutline((prev) => {
      const next = { ...prev };
      if (type === "module") {
        next.modules.splice(path.moduleIndex, 1);
      } else if (type === "section") {
        next.modules[path.moduleIndex].sections.splice(path.sectionIndex, 1);
      } else if (type === "sco") {
        next.modules[path.moduleIndex].sections[path.sectionIndex].scos.splice(path.scoIndex, 1);
      } else if (type === "screen") {
        next.modules[path.moduleIndex].sections[path.sectionIndex].scos[path.scoIndex].screens.splice(path.screenIndex, 1);
      }
      return next;
    });
  };

  const handleConfirm = () => {
    onChange(localOutline);
    onConfirm(localOutline);
  };

  if (!localOutline || !Array.isArray(localOutline.modules)) {
    return <div className="panel stack">Incorrect outline format.</div>;
  }

  return (
    <div className="panel stack outline-editor">
      <div className="tree-header" style={{ borderBottom: '1px solid #e2e8f0', paddingBottom: '1rem', marginBottom: '1rem' }}>
        <h3 style={{ margin: 0, fontSize: '1.25rem' }}>Редактор структуры курса (Interactive AI)</h3>
        <p className="meta" style={{ margin: '0.25rem 0 0 0', color: '#64748b' }}>
          Отредактируйте сгенерированные заголовки или удалите лишние элементы перед финальной генерацией текстов (Фаза Б).
        </p>
      </div>

      <div className="outline-tree stack" style={{ maxHeight: '600px', overflowY: 'auto', paddingRight: '1rem' }}>
        {localOutline.modules.map((mod, mIdx) => (
          <div key={`m-${mIdx}`} className="tree-node module-node stack" style={{ padding: '1rem', backgroundColor: '#f8fafc', borderRadius: '8px', border: '1px solid #e2e8f0' }}>
            <div className="node-header" style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
              <span className="badge" style={{ backgroundColor: '#3b82f6', color: 'white', padding: '2px 8px', borderRadius: '12px', fontSize: '0.75rem' }}>Модуль {mIdx + 1}</span>
              <input 
                value={mod.title} 
                onChange={(e) => updateTitle('module', { moduleIndex: mIdx }, e.target.value)}
                style={{ flex: 1, padding: '0.25rem 0.5rem', border: '1px solid #cbd5e1', borderRadius: '4px', fontWeight: 'bold' }}
              />
              <button type="button" onClick={() => removeNode('module', { moduleIndex: mIdx })} style={{ color: '#ef4444', background: 'none', border: 'none', cursor: 'pointer' }}>✕</button>
            </div>

            <div className="tree-children stack" style={{ paddingLeft: '2rem', gap: '0.75rem', marginTop: '0.5rem' }}>
              {(mod.sections || []).map((sec, sIdx) => (
                <div key={`s-${mIdx}-${sIdx}`} className="tree-node section-node stack" style={{ gap: '0.5rem' }}>
                  <div className="node-header" style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                    <span className="badge" style={{ backgroundColor: '#64748b', color: 'white', padding: '2px 8px', borderRadius: '12px', fontSize: '0.75rem' }}>Раздел</span>
                    <input 
                      value={sec.title} 
                      onChange={(e) => updateTitle('section', { moduleIndex: mIdx, sectionIndex: sIdx }, e.target.value)}
                      style={{ flex: 1, padding: '0.25rem 0.5rem', border: '1px solid #cbd5e1', borderRadius: '4px' }}
                    />
                    <button type="button" onClick={() => removeNode('section', { moduleIndex: mIdx, sectionIndex: sIdx })} style={{ color: '#ef4444', background: 'none', border: 'none', cursor: 'pointer' }}>✕</button>
                  </div>

                  <div className="tree-children stack" style={{ paddingLeft: '2rem', gap: '0.5rem' }}>
                    {(sec.scos || []).map((sco, scIdx) => (
                      <div key={`sco-${mIdx}-${sIdx}-${scIdx}`} className="tree-node sco-node stack" style={{ gap: '0.5rem' }}>
                        <div className="node-header" style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                          <span className="badge" style={{ backgroundColor: '#e2e8f0', color: '#334155', padding: '2px 8px', borderRadius: '12px', fontSize: '0.75rem' }}>SCO</span>
                          <input 
                            value={sco.title} 
                            onChange={(e) => updateTitle('sco', { moduleIndex: mIdx, sectionIndex: sIdx, scoIndex: scIdx }, e.target.value)}
                            style={{ flex: 1, padding: '0.25rem 0.5rem', border: '1px solid #cbd5e1', borderRadius: '4px', fontSize: '0.9rem' }}
                          />
                          <button type="button" onClick={() => removeNode('sco', { moduleIndex: mIdx, sectionIndex: sIdx, scoIndex: scIdx })} style={{ color: '#ef4444', background: 'none', border: 'none', cursor: 'pointer' }}>✕</button>
                        </div>

                        <div className="tree-children" style={{ paddingLeft: '2.5rem', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                          {(sco.screens || []).map((screen, skrIdx) => (
                            <div key={`skr-${mIdx}-${sIdx}-${scIdx}-${skrIdx}`} className="tree-node screen-node" style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                              <span style={{ color: '#94a3b8' }}>↳</span>
                              <input 
                                value={screen.title} 
                                onChange={(e) => updateTitle('screen', { moduleIndex: mIdx, sectionIndex: sIdx, scoIndex: scIdx, screenIndex: skrIdx }, e.target.value)}
                                style={{ flex: 1, padding: '0.15rem 0.5rem', border: '1px solid transparent', borderBottom: '1px dashed #cbd5e1', backgroundColor: 'transparent', fontSize: '0.85rem' }}
                              />
                              <button type="button" onClick={() => removeNode('screen', { moduleIndex: mIdx, sectionIndex: sIdx, scoIndex: scIdx, screenIndex: skrIdx })} style={{ color: '#ef4444', background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.8rem' }}>✕</button>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="actions" style={{ display: 'flex', gap: '1rem', marginTop: '1.5rem', paddingTop: '1rem', borderTop: '1px solid #e2e8f0' }}>
        <button type="button" onClick={onCancel} className="secondary">
          Отмена
        </button>
        <button type="button" onClick={handleConfirm} className="primary" style={{ flex: 1 }}>
          Утвердить структуру и сгенерировать контент
        </button>
      </div>
    </div>
  );
}
