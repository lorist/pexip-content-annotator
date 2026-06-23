/**
 * Minimal `@pexip/plugin-api` stand-in for local dev (vite). Just enough
 * surface for index.ts to register a button and for the capture spike to
 * return a placeholder image so the editor popup can be exercised.
 */
export function createMockPlugin(): any {
  const signal = () => ({ add: (_: any) => {}, remove: (_: any) => {} });
  const placeholder = makePlaceholder();

  return {
    events: {
      authenticatedWithConference: signal(),
      presentationConnectionStateChange: signal(),
      participants: signal(),
      me: signal(),
      message: signal(),
      conferenceStatus: signal(),
    },
    ui: {
      addButton: async () => ({
        // expose the handler so you can trigger it from the dev console:
        //   window.__triggerSnapshot()
        onClick: { add: (h: any) => ((window as any).__triggerSnapshot = h) },
        update: () => {},
      }),
      showToast: (o: any) => console.log('[mock toast]', o?.message),
      showForm: async () => undefined,
    },
    conference: {
      sendRequest: async () => ({
        status: 200,
        data: { status: 'success', result: placeholder },
      }),
      requestParticipants: async () => ({ data: { result: [] } }),
      setRole: async () => {},
    },
  };
}

function makePlaceholder(): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720">
    <rect width="100%" height="100%" fill="#11151c"/>
    <rect x="40" y="40" width="1200" height="640" rx="16" fill="#1b2330" stroke="#2b3a52" stroke-width="2"/>
    <text x="640" y="330" fill="#8fa6c9" font-family="sans-serif" font-size="44" text-anchor="middle">Mock content frame</text>
    <text x="640" y="392" fill="#5b6b85" font-family="sans-serif" font-size="22" text-anchor="middle">local dev placeholder — annotate &amp; save</text>
  </svg>`;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}
