import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * The app had no error boundary at all, so ONE render error took the whole
 * tree down: React unmounted #root and left an empty near-black page with
 * nothing to click. That is what a hooks-order violation in the scan modal did
 * to the library — a click, then nothing, with no hint of what happened.
 *
 * A crash should cost the screen, not the session, and it should say so. The
 * fallback deliberately uses inline styles and no app providers: whatever
 * threw may be the very thing that styles or wraps this.
 */
interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Keep the component stack. Production React reports numeric codes, and
    // the stack is the only way to tell which screen threw.
    console.error("[ErrorBoundary]", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div
        role="alert"
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
          background: "hsl(224 71% 4%)",
          color: "hsl(213 31% 91%)",
          fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
        }}
      >
        <div style={{ maxWidth: 560, width: "100%" }}>
          <h1 style={{ fontSize: 20, fontWeight: 600, margin: "0 0 8px" }}>This screen stopped</h1>
          <p style={{ fontSize: 14, lineHeight: 1.6, margin: "0 0 16px", color: "hsl(215 20% 65%)" }}>
            Something went wrong while drawing this page, so it stopped rather than carry on with
            broken state. Reloading usually clears it. If it keeps happening, send us the line below.
          </p>
          <pre
            style={{
              fontSize: 12,
              lineHeight: 1.5,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              background: "hsl(224 45% 9%)",
              border: "1px solid hsl(216 34% 17%)",
              borderRadius: 8,
              padding: 12,
              margin: "0 0 16px",
            }}
          >
            {error.message || String(error)}
          </pre>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={() => window.location.reload()}
              style={{
                height: 36,
                padding: "0 14px",
                borderRadius: 8,
                border: "1px solid hsl(216 34% 17%)",
                background: "hsl(210 100% 52%)",
                color: "white",
                fontSize: 13,
                cursor: "pointer",
              }}
              data-testid="button-error-reload"
            >
              Reload the page
            </button>
            <button
              onClick={() => {
                this.setState({ error: null });
                if (window.history.length > 1) window.history.back();
                else window.location.assign("/");
              }}
              style={{
                height: 36,
                padding: "0 14px",
                borderRadius: 8,
                border: "1px solid hsl(216 34% 17%)",
                background: "transparent",
                color: "hsl(213 31% 91%)",
                fontSize: 13,
                cursor: "pointer",
              }}
              data-testid="button-error-back"
            >
              Go back
            </button>
          </div>
        </div>
      </div>
    );
  }
}

export default ErrorBoundary;
