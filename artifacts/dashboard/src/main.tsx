import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { offMountRedirect } from './config';
import './styles.css';

/**
 * Last line of defence for the whole tree. Without it, ONE render throw
 * unmounts everything React ever painted and the user gets a silent white
 * page — which is exactly how the un-awaited /api/settings Promise of
 * 2026-08-08 presented: the app flashed, then blanked, with the only evidence
 * in the browser console. A crash can still happen; it must never be mute.
 */
class CrashScreen extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('dashboard crashed', error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="app">
        <div className="empty" style={{ maxWidth: 520, margin: '80px auto', textAlign: 'center' }}>
          <p className="empty-title">Something went wrong</p>
          <p className="empty-sub">
            The dashboard hit an unexpected error. Reloading usually clears it; if it keeps
            happening, tell the person who runs this tool what the message below says.
          </p>
          <p className="mono small" style={{ color: 'var(--danger)', overflowWrap: 'anywhere' }}>
            {String(this.state.error)}
          </p>
          <button className="btn primary" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      </div>
    );
  }
}

/**
 * Legacy address survival, browser half.
 *
 * Runs BEFORE the router mounts, so a page that loaded outside this app's mount
 * moves to the mount without first issuing API calls from the wrong base. The
 * decision itself lives in config.ts (`offMountRedirect`) so it can be executed
 * by a gate; everything load-bearing about it — inert while unprefixed, stays on
 * this origin, preserves query and fragment, one hop — is asserted there.
 *
 * `replace` rather than `assign`: the stale address never enters history, so the
 * back button cannot bounce between the two.
 */
const to = offMountRedirect(window.location.pathname, window.location.search, window.location.hash);

if (to !== null) {
  window.location.replace(to);
} else {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <CrashScreen>
        <App />
      </CrashScreen>
    </React.StrictMode>
  );
}
