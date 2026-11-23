import React, { Component, ErrorInfo, ReactNode } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  errorMessage: string;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  public state: ErrorBoundaryState = {
    hasError: false,
    errorMessage: "",
  };

  public static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return {
      hasError: true,
      errorMessage: error?.message || "An unexpected rendering error occurred.",
    };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error("YG Flash Anime UI ErrorBoundary caught:", error, errorInfo);
  }

  private handleReload = () => {
    this.setState({ hasError: false, errorMessage: "" });
    if (typeof window !== "undefined") {
      window.location.reload();
    }
  };

  public render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-[#070709] text-white flex items-center justify-center p-6">
          <div className="max-w-md w-full rounded-3xl bg-[#111319] border border-white/10 p-6 text-center space-y-4 shadow-2xl">
            <div className="w-12 h-12 rounded-2xl bg-rose-500/15 border border-rose-500/30 text-rose-400 flex items-center justify-center mx-auto">
              <AlertTriangle className="w-6 h-6" />
            </div>
            <div className="space-y-1.5">
              <h2 className="text-lg font-black tracking-tight">Something went wrong</h2>
              <p className="text-xs text-neutral-400 leading-relaxed">
                {this.state.errorMessage || "The screen hit an unexpected error."}
              </p>
            </div>
            <button
              type="button"
              onClick={this.handleReload}
              className="w-full min-h-[44px] px-4 py-2.5 rounded-xl bg-[var(--primary,#10b981)] text-white text-xs font-bold flex items-center justify-center gap-2 active:scale-95 transition-transform"
            >
              <RefreshCw className="w-4 h-4" />
              <span>Reload Application</span>
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
