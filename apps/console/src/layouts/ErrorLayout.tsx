import React from 'react';

const ErrorLayout: React.FC<{ errorCode: number }> = ({ errorCode }) => {
  return (
    <div className="error-layout">
      {errorCode === 404 ? (
        <div>
          <h1>404</h1>
          <p>Page not found</p>
        </div>
      ) : (
        <div>
          <h1>Error</h1>
          <p>Something went wrong</p>
        </div>
      )}
    </div>
  );
}

export default ErrorLayout;