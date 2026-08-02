import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { offMountRedirect } from './config';
import './styles.css';

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
      <App />
    </React.StrictMode>
  );
}
