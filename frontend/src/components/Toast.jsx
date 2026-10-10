import Icon from "./Icon";

export default function Toast({ toasts, dismiss }) {
  return (
    <div
      className="toast-region"
      aria-label="Notifications"
      aria-live="polite"
      aria-atomic="false"
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`toast toast-${toast.type}`}
          role={toast.type === "error" ? "alert" : "status"}
        >
          <span className="toast-symbol">
            <Icon
              name={toast.type === "error" ? "warning" : "check"}
              size={18}
            />
          </span>
          <span>{toast.message}</span>
          <button
            className="icon-button"
            aria-label="Dismiss notification"
            onClick={() => dismiss(toast.id)}
          >
            <Icon name="close" size={16} />
          </button>
        </div>
      ))}
    </div>
  );
}
