export function ModuleStatus({ moduleStreamState }) {
  if (!moduleStreamState.courseId) return null;

  return (
    <div className="status">
      <strong>Module ready: </strong>
      {moduleStreamState.completedModules}/{moduleStreamState.totalModules || "?"}
      {moduleStreamState.lastModuleTitle ? " - " + moduleStreamState.lastModuleTitle : ""}
      <div className="actions">
        <a
          className="link-button"
          href={"/courses/" + moduleStreamState.courseId}
          target="_blank"
          rel="noreferrer"
        >
          Open current draft
        </a>
      </div>
    </div>
  );
}
