import { describe, expect, it } from 'vitest';
import {
  buildWorkbenchArtifactLinkPreviewUrl,
  buildWorkbenchArtifactVersionPreviewUrl,
  resolveApiBaseUrlForLocation,
  resolveApiErrorMessage,
} from './client.js';

describe('resolveApiBaseUrlForLocation', () => {
  it('prefers explicit api base urls and trims trailing slash', () => {
    expect(resolveApiBaseUrlForLocation(
      {
        protocol: 'http:',
        hostname: '127.0.0.1',
        port: '5177',
        origin: 'http://127.0.0.1:5177',
      },
      'https://api.example.com/base/',
    )).toBe('https://api.example.com/base');
  });

  it('routes localhost development traffic to port 3300', () => {
    expect(resolveApiBaseUrlForLocation({
      protocol: 'http:',
      hostname: '127.0.0.1',
      port: '5177',
      origin: 'http://127.0.0.1:5177',
    })).toBe('http://127.0.0.1:3300/api');
  });

  it('uses same-origin api routes for non-local hosts', () => {
    expect(resolveApiBaseUrlForLocation({
      protocol: 'https:',
      hostname: 'workbench.example.com',
      port: '443',
      origin: 'https://workbench.example.com',
    })).toBe('https://workbench.example.com/api');
  });

  it('keeps same-origin api routes when already served from the api port', () => {
    expect(resolveApiBaseUrlForLocation({
      protocol: 'http:',
      hostname: '127.0.0.1',
      port: '3300',
      origin: 'http://127.0.0.1:3300',
    })).toBe('/api');
  });
});

describe('resolveApiErrorMessage', () => {
  it('prefers v1 error envelope messages', () => {
    expect(resolveApiErrorMessage({
      error: {
        code: 'transition_not_allowed',
        message: 'Cannot transition backlog to completed.',
      },
    }, 'Conflict', 409)).toBe('Cannot transition backlog to completed.');
  });

  it('prefers Fastify route messages over generic status text', () => {
    expect(resolveApiErrorMessage({
      message: 'Route GET:/api/v1/tasks not found',
      error: 'Not Found',
      statusCode: 404,
    }, 'Not Found', 404)).toBe('Route GET:/api/v1/tasks not found');
  });
});

describe('artifact preview urls', () => {
  it('builds artifact-id preview URLs for first-class artifact previews', () => {
    expect(buildWorkbenchArtifactVersionPreviewUrl('art_abc', 'ver_123')).toBe(
      '/api/workbench/artifacts/art_abc/versions/ver_123/preview',
    );
  });

  it('prefers artifact-id preview URLs and only falls back to legacy paths when ids are missing', () => {
    expect(buildWorkbenchArtifactLinkPreviewUrl({
      artifactId: 'art_abc',
      versionId: 'ver_123',
      filePath: '/tmp/preview.html',
    })).toBe('/api/workbench/artifacts/art_abc/versions/ver_123/preview');

    expect(buildWorkbenchArtifactLinkPreviewUrl({
      filePath: '/tmp/preview.html',
    })).toBe('/api/workbench/artifacts/preview?path=%2Ftmp%2Fpreview.html');
  });
});
