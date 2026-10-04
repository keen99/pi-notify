import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Test-only provider used by the deep smoke: registers a fake
// openai-completions provider whose baseUrl points at a local canned-SSE
// HTTP server. Lets the smoke drive a REAL agent turn (before_agent_start →
// LLM round-trip → agent_end) with no external model. Not shipped logic —
// only loaded when the smoke passes -e test/mock-provider.ts.
export default function (pi: ExtensionAPI): void {
	pi.registerProvider("mocktest", {
		name: "Mock Test",
		baseUrl: process.env.MOCK_BASE_URL!,
		apiKey: "MOCK_API_KEY",
		api: "openai-completions",
		models: [
			{
				id: "mock-model",
				name: "Mock Model",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 4096,
			},
		],
	});
}
