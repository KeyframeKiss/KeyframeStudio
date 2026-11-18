import { Component, type ReactNode } from 'react';

/**
 * Keeps a crash in one panel from blanking the whole window: shows what failed and a retry button.
 * (React only catches render errors through a class component.)
 */
export class ErrorBoundary extends Component<{ name: string; children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    // console.error is captured into the Studio EX log (lib/log.ts)
    console.error(`[${this.props.name}] crashed:`, error, info?.componentStack ?? '');
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="empty" style={{ margin: 'auto' }}>
        <strong>{this.props.name} hit an error</strong>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{this.state.error.message}</span>
        <button className="btn primary" style={{ marginTop: 10 }} onClick={() => this.setState({ error: null })}>
          Try again
        </button>
      </div>
    );
  }
}
