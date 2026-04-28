import { Component, type ErrorInfo, type ReactNode } from "react";

// Defensive boundary used to wrap heavy/risky subtrees (e.g. the virtualised
// catalog grid). React's default behaviour for an uncaught render error is
// to unmount the entire root, which on this app meant the user saw a fully
// black window. Capturing the error here lets us swap the broken subtree
// for a small "something went wrong" panel and a retry button — the rest of
// the app (TopBar, navigation, etc.) keeps working.

interface Props {
  children: ReactNode;
  // Custom fallback UI. If omitted, a minimal red banner is shown.
  fallback?: (error: Error, reset: () => void) => ReactNode;
}

interface State {
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Log so the user can paste the stack trace if they ever need to.
    // Avoid noisy console.error to not look like an unhandled crash.
    console.warn("[ErrorBoundary] caught render error:", error, info.componentStack);
  }

  reset = () => {
    this.setState({ error: null });
  };

  render() {
    if (this.state.error) {
      if (this.props.fallback) {
        return this.props.fallback(this.state.error, this.reset);
      }
      return (
        <div className="flex-1 flex flex-col items-center justify-center p-6 gap-3 text-center">
          <div className="text-red-400 font-medium">
            Algo deu errado ao renderizar essa tela.
          </div>
          <div className="text-xs text-slate-400 max-w-xl break-all">
            {this.state.error.message}
          </div>
          <button onClick={this.reset} className="btn-primary mt-2">
            Tentar novamente
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
