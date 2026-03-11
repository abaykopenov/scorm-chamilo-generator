export function ProgressSection({ generationProgress }) {
  if (!generationProgress.active) return null;

  return (
    <div className="generation-progress" role="status" aria-live="polite">
      <div className="generation-progress-head">
        <strong>{generationProgress.message || "Course generation"}</strong>
        <span>{generationProgress.percent}%</span>
      </div>
      <div className="generation-progress-track">
        <div
          className="generation-progress-fill"
          style={{ width: String(generationProgress.percent) + "%" }}
        />
      </div>
    </div>
  );
}
