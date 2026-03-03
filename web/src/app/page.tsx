'use client';

import { useState, useEffect } from 'react';

type EndpointResult = {
  status: number | null;
  data: unknown;
  error?: string;
};

function useApiCall(apiUrl: string) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<EndpointResult | null>(null);

  const call = async (endpointPath: string, method: 'GET' | 'POST', body?: unknown) => {
    setLoading(true);
    setResult(null);
    try {
      const res = await fetch(`${apiUrl}${endpointPath}`, {
        method,
        headers: method === 'POST' ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json();
      setResult({ status: res.status, data });
    } catch (err) {
      setResult({ status: null, data: null, error: String(err) });
    } finally {
      setLoading(false);
    }
  };

  return { loading, result, call };
}

function ResponseBox({ result, loading }: { result: EndpointResult | null; loading: boolean }) {
  if (loading) return <div className="response-area">Loading...</div>;
  if (!result) return <div className="response-area" style={{ color: '#4a5568' }}>— no response yet —</div>;
  const isOk = result.status !== null && result.status < 400;
  return (
    <div className="response-area">
      <span className={isOk ? 'status-ok' : 'status-err'}>
        {result.status ? `HTTP ${result.status}` : 'ERROR'}
      </span>
      {'\n'}
      {result.error ?? JSON.stringify(result.data, null, 2)}
    </div>
  );
}

export default function Page() {
  const [apiUrl, setApiUrl] = useState('');

  // Fetch the live API URL from config.json deployed alongside the static site.
  // This avoids baking a CloudFormation token into the JS bundle at build time.
  useEffect(() => {
    fetch('/config.json')
      .then(r => r.json())
      .then(cfg => { if (cfg.apiUrl) setApiUrl(cfg.apiUrl); })
      .catch(() => {});
  }, []);

  const hello = useApiCall(apiUrl);
  const process = useApiCall(apiUrl);
  const workflow = useApiCall(apiUrl);

  return (
    <div className="container">
      <h1>Stackform Demo</h1>
      <p className="subtitle">CDK app with Lambda, Step Functions, API Gateway, DynamoDB &amp; SQS</p>

      <div className="api-url-card">
        <span>API Endpoint: </span>
        <code>{apiUrl || 'loading...'}</code>
      </div>

      <h2>Endpoints</h2>
      <div className="endpoints">

        {/* Hello */}
        <div className="endpoint-card">
          <div className="endpoint-header">
            <span className="method-badge method-get">GET</span>
            <span className="path">/hello</span>
          </div>
          <p className="desc">Returns greeting, timestamp, and DynamoDB item count.</p>
          <button
            onClick={() => hello.call('/hello', 'GET')}
            disabled={hello.loading || !apiUrl}
            style={{ marginTop: '0.75rem' }}
          >
            {hello.loading ? 'Calling...' : 'Call /hello'}
          </button>
          <ResponseBox result={hello.result} loading={hello.loading} />
        </div>

        {/* Process */}
        <div className="endpoint-card">
          <div className="endpoint-header">
            <span className="method-badge method-post">POST</span>
            <span className="path">/process</span>
          </div>
          <p className="desc">Writes a record to DynamoDB and enqueues an SQS message.</p>
          <button
            onClick={() => process.call('/process', 'POST', { text: 'hello from stackform', source: 'web-ui' })}
            disabled={process.loading || !apiUrl}
            style={{ marginTop: '0.75rem' }}
          >
            {process.loading ? 'Calling...' : 'Call /process'}
          </button>
          <ResponseBox result={process.result} loading={process.loading} />
        </div>

        {/* Workflow */}
        <div className="endpoint-card">
          <div className="endpoint-header">
            <span className="method-badge method-post">POST</span>
            <span className="path">/workflow/start</span>
          </div>
          <p className="desc">Starts the Step Functions Express workflow (Hello → Process → Notify).</p>
          <button
            onClick={() => workflow.call('/workflow/start', 'POST', { trigger: 'web-ui', timestamp: new Date().toISOString() })}
            disabled={workflow.loading || !apiUrl}
            style={{ marginTop: '0.75rem' }}
          >
            {workflow.loading ? 'Running workflow...' : 'Start Workflow'}
          </button>
          <ResponseBox result={workflow.result} loading={workflow.loading} />
        </div>

      </div>

      <p style={{ color: '#4a5568', fontSize: '0.75rem', textAlign: 'center' }}>
        Deployed via Stackform · CDK TypeScript · {new Date().getFullYear()}
      </p>
    </div>
  );
}
