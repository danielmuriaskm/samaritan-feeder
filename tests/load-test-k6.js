import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '1m', target: 50 },
    { duration: '3m', target: 200 },
    { duration: '1m', target: 400 },
    { duration: '2m', target: 100 },
    { duration: '1m', target: 0 },
  ],
  thresholds: {
    http_req_duration: ['p(95)<500'],
    http_req_failed: ['rate<0.01'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';

export default function () {
  const endpoints = [
    { url: `${BASE_URL}/health`, method: 'GET' },
    { url: `${BASE_URL}/sources`, method: 'GET' },
    { url: `${BASE_URL}/events?limit=20`, method: 'GET' },
    { url: `${BASE_URL}/events?query=traffic&limit=10`, method: 'GET' },
    { url: `${BASE_URL}/dashboard`, method: 'GET' },
    { url: `${BASE_URL}/library/webcams`, method: 'GET' },
  ];

  const endpoint = endpoints[Math.floor(Math.random() * endpoints.length)];
  const res = http.get(endpoint.url);

  check(res, {
    'status is 200': (r) => r.status === 200,
    'response time < 500ms': (r) => r.timings.duration < 500,
  });

  sleep(Math.random() * 2 + 0.5);
}
