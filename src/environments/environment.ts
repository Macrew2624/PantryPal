const backendPort = 3000;

export function getBackendUrls(hostname: string): { apiUrl: string; wsUrl: string } {
  return {
    apiUrl: `http://${hostname}:${backendPort}/api`,
    wsUrl: `ws://${hostname}:${backendPort}`,
  };
}

const pageLocation = typeof window === 'undefined' ? { hostname: 'localhost', protocol: 'http:' } : window.location;

export const environment = {
  production: false,
  ...getBackendUrls(pageLocation.hostname),
};
