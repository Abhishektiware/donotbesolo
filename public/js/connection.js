(function () {
  // Use environment-based API base URL: localhost on local hosts, relative/origin in production
  const API_BASE_URL = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' || window.location.protocol === 'file:'
    ? 'http://localhost:3000'
    : '';

  const originalFetch = window.fetch;

  let failedRequestsQueue = [];
  let offlineBanner = null;

  // Insert custom styles dynamically for the cyberpunk offline banner
  const style = document.createElement('style');
  style.innerHTML = `
    #cyber-offline-banner {
      position: fixed;
      bottom: 20px;
      left: 50%;
      transform: translateX(-50%);
      background: rgba(20, 10, 30, 0.95);
      border: 2px solid #ff2a75;
      box-shadow: 0 0 20px rgba(255, 42, 117, 0.4), inset 0 0 10px rgba(255, 42, 117, 0.2);
      color: #fff;
      padding: 16px 24px;
      border-radius: 12px;
      z-index: 10000;
      display: flex;
      align-items: center;
      gap: 15px;
      font-family: sans-serif;
      backdrop-filter: blur(10px);
      transition: all 0.3s ease;
    }
    #cyber-offline-banner .banner-icon {
      font-size: 24px;
    }
    #cyber-offline-banner .banner-text {
      flex-grow: 1;
    }
    #cyber-offline-banner .banner-title {
      font-weight: bold;
      color: #ff2a75;
      margin-bottom: 2px;
      font-size: 14px;
    }
    #cyber-offline-banner .banner-sub {
      font-size: 12px;
      color: #aaa;
    }
    #cyber-retry-btn {
      background: linear-gradient(135deg, #ff2a75, #ff4d94);
      border: none;
      color: white;
      padding: 8px 16px;
      border-radius: 6px;
      cursor: pointer;
      font-weight: bold;
      font-size: 12px;
      box-shadow: 0 0 10px rgba(255, 42, 117, 0.5);
      transition: all 0.2s ease;
      white-space: nowrap;
    }
    #cyber-retry-btn:hover {
      box-shadow: 0 0 15px rgba(255, 42, 117, 0.8);
      transform: scale(1.02);
    }
    #cyber-retry-btn:active {
      transform: scale(0.98);
    }
    #cyber-retry-btn:disabled {
      background: #555;
      box-shadow: none;
      cursor: not-allowed;
    }
    @keyframes cyber-shake {
      0%, 100% { transform: translateX(-50%); }
      25% { transform: translateX(-52%); }
      75% { transform: translateX(-48%); }
    }
  `;
  document.head.appendChild(style);

  function showOfflineBanner() {
    if (offlineBanner) return;
    offlineBanner = document.createElement('div');
    offlineBanner.id = 'cyber-offline-banner';
    offlineBanner.innerHTML = `
      <span class="banner-icon">⚠️</span>
      <div class="banner-text">
        <div class="banner-title">Connection offline</div>
        <div class="banner-sub">Server is currently unreachable.</div>
      </div>
      <button id="cyber-retry-btn">Retry Connection</button>
    `;
    document.body.appendChild(offlineBanner);

    document.getElementById('cyber-retry-btn').addEventListener('click', async () => {
      const btn = document.getElementById('cyber-retry-btn');
      btn.disabled = true;
      btn.innerText = 'Checking...';

      try {
        console.log(`[Offline Check]: Verifying connection to backend at ${API_BASE_URL}/api/health...`);
        const check = await originalFetch(`${API_BASE_URL}/api/health`);
        if (check.ok) {
          console.log('[Offline Check]: Backend is back online! Processing queued requests...');
          hideOfflineBanner();
          retryFailedRequests();
        } else {
          throw new Error('Health check responded but status not OK.');
        }
      } catch (e) {
        console.warn('[Offline Check]: Connection check failed. Server is still unreachable.', e);
        btn.disabled = false;
        btn.innerText = 'Retry Connection';
        offlineBanner.style.animation = 'cyber-shake 0.5s';
        setTimeout(() => { offlineBanner.style.animation = ''; }, 500);
      }
    });
  }

  function hideOfflineBanner() {
    if (offlineBanner) {
      offlineBanner.remove();
      offlineBanner = null;
    }
  }

  async function retryFailedRequests() {
    const queue = [...failedRequestsQueue];
    failedRequestsQueue = [];
    for (const req of queue) {
      try {
        console.log(`[API Retry]: Retrying queued request for ${req.url}`);
        const res = await window.fetch(req.url, req.options);
        req.resolve(res);
      } catch (err) {
        req.reject(err);
      }
    }
  }

  window.fetch = async function (url, options = {}) {
    let targetUrl = url;
    if (typeof url === 'string' && url.startsWith('/api/')) {
      targetUrl = API_BASE_URL + url;
    }

    const maxRetries = 3;
    let attempt = 0;

    while (attempt < maxRetries) {
      try {
        const response = await originalFetch(targetUrl, options);

        // Treat 2xx status codes and client errors (4xx) as successful server responses.
        // If it's a client error (like 401 Unauthorized or 404 Not Found), the server is reachable and active.
        if (response.ok || (response.status >= 400 && response.status < 600)) {
          return response;
        }

        throw new Error(`Server returned error status: ${response.status}`);
      } catch (error) {
        attempt++;
        if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' || window.location.protocol === 'file:') {
          console.warn(`[API Retry] Fetch failed for ${url} (Attempt ${attempt}/${maxRetries}): ${error.message}`);
        }

        if (attempt >= maxRetries) {
          // If this was a health check itself, let the error bubble up without adding to queue
          if (typeof url === 'string' && url.endsWith('/health')) {
            throw error;
          }

          showOfflineBanner();

          return new Promise((resolve, reject) => {
            failedRequestsQueue.push({
              url,
              options,
              resolve,
              reject
            });
          });
        }

        // Delay with backoff
        await new Promise(r => setTimeout(r, 1000 * attempt));
      }
    }
  };
})();
