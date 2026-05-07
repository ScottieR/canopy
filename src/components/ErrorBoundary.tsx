import React from 'react';

interface Props {
  children: React.ReactNode;
  fallback?: React.ReactNode;
  onError?: (errorInfo: { message: string; componentStack: string; timestamp: string }) => void;
  showDetails?: boolean;
  allowNavigation?: boolean;
}

interface State {
  hasError: boolean;
  error?: Error;
  errorInfo?: React.ErrorInfo;
}

export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = {
      hasError: false,
      error: undefined,
      errorInfo: undefined,
    };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return {
      hasError: true,
      error,
    };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    // Update state with error info
    this.setState({ errorInfo });

    // Log error for monitoring
    console.error('ErrorBoundary caught error:', error, errorInfo);

    // Call the onError callback if provided with formatted error object
    if (this.props.onError) {
      this.props.onError({
        message: error.message,
        componentStack: errorInfo.componentStack,
        timestamp: new Date().toISOString(),
      });
    }
  }

  handleReset = () => {
    this.setState({
      hasError: false,
      error: undefined,
      errorInfo: undefined,
    });
  };

  render() {
    if (this.state.hasError) {
      // Custom fallback if provided
      if (this.props.fallback) {
        return this.props.fallback;
      }

      // Default error UI
      return (
        <div
          role="alert"
          style={{
            padding: '20px',
            margin: '20px',
            border: '1px solid #ff6b6b',
            borderRadius: '8px',
            backgroundColor: '#ffe0e0',
            color: '#c92a2a',
          }}
        >
          <img
            src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%23c92a2a' width='40' height='40'%3E%3Ccircle cx='12' cy='12' r='10'/%3E%3Ctext x='12' y='17' text-anchor='middle' fill='white' font-size='16' font-weight='bold'%3E!%3C/text%3E%3C/svg%3E"
            role="img"
            hidden={true}
            alt="error icon"
            style={{ marginBottom: '12px' }}
          />

          <h2>Something went wrong</h2>

          {this.props.showDetails && this.state.error && (
            <>
              <p><strong>Error:</strong> {this.state.error.message}</p>
              {this.state.errorInfo && (
                <details style={{ marginTop: '12px', fontSize: '12px', whiteSpace: 'pre-wrap' }}>
                  <summary>Component Stack</summary>
                  <code>{this.state.errorInfo.componentStack}</code>
                </details>
              )}
            </>
          )}

          {!this.props.showDetails && (
            <p>An error occurred. Please try again.</p>
          )}

          <button
            onClick={this.handleReset}
            style={{
              padding: '8px 16px',
              backgroundColor: '#ff6b6b',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              marginTop: '12px',
            }}
          >
            Try again
          </button>

          {this.props.allowNavigation && (
            <div style={{ marginTop: '12px' }}>
              <a href="/" style={{ color: '#ff6b6b', textDecoration: 'underline' }}>
                Back to Dashboard
              </a>
            </div>
          )}
        </div>
      );
    }

    return this.props.children;
  }
}
