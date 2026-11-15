import { describe, expect, it } from 'vitest';

import { getBackendUrls } from './environment';

describe('development API addresses', () => {
  it('uses the hostname of the browser serving the app for REST and WebSocket requests', () => {
    expect(getBackendUrls('192.168.1.25')).toEqual({
      apiUrl: 'http://192.168.1.25:3000/api',
      wsUrl: 'ws://192.168.1.25:3000',
    });
  });
});
