export function StatusPill(props: {
  icon: JSX.Element;
  label: string;
  tone: "neutral" | "success" | "warning" | "danger";
}) {
  return (
    <span className={`statusPill ${props.tone}`}>
      {props.icon}
      {props.label}
    </span>
  );
}

export function StatusBadge(props: {
  tone: "neutral" | "success" | "warning" | "danger" | "info";
  text: string;
}): JSX.Element {
  return <span className={`statusBadge ${props.tone}`}>{props.text}</span>;
}

export function StatusDot(props: { status: "success" | "warning" | "danger" | "neutral" }): JSX.Element {
  return <span className={`statusDot ${props.status}`} aria-hidden="true" />;
}

export function Metric(props: { label: string; value: number | string }): JSX.Element {
  return (
    <div className="metric">
      <span>{props.label}</span>
      <strong>{props.value}</strong>
    </div>
  );
}
