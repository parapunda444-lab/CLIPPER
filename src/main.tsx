import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";
class StudioBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(
      "The studio encountered an error:",
      error.message,
      info.componentStack,
    );
  }
  render() {
    return this.state.failed ? (
      <div className="fatal-error">
        <h1>Let’s get you back to creating.</h1>
        <p>
          The studio hit an unexpected error. Your saved project hasn’t been
          cleared.
        </p>
        <button onClick={() => location.reload()}>Reload studio</button>
      </div>
    ) : (
      this.props.children
    );
  }
}
createRoot(document.getElementById("root")!).render(
  <StudioBoundary>
    <App />
  </StudioBoundary>,
);
