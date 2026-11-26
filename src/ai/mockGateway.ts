/**
 * Demo gateway: runs the local heuristic and returns it in the exact shape a
 * model would. Used when Firebase is not configured (or fails to initialise),
 * so the web demo and the extension remain fully usable for judging.
 */

import { mockTriage } from "../core/mockEngine";
import type {
  AiGateway,
  GatewayCapabilities,
  GenerationOutput,
  GenerationRequest
} from "./gateway";

export interface MockGatewayOptions {
  /** Artificial delay so the pipeline behaves like a real call. Defaults to ~200–400 ms. */
  simulateLatency?: boolean;
}

export class MockGateway implements AiGateway {
  readonly engine = "mock" as const;
  readonly label = "Local demo heuristic";
  readonly cloudModel = "local-heuristic-v1";

  private readonly simulateLatency: boolean;

  constructor(options: MockGatewayOptions = {}) {
    this.simulateLatency = options.simulateLatency ?? true;
  }

  async capabilities(): Promise<GatewayCapabilities> {
    return { onDevice: "unavailable", appCheck: false, cloudModel: this.cloudModel };
  }

  async prepareOnDevice(): Promise<void> {
    // Nothing to download — the heuristic is already in the bundle.
  }

  async generate(request: GenerationRequest): Promise<GenerationOutput> {
    if (this.simulateLatency) {
      const delay = 160 + (request.text.length % 220);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    return {
      text: JSON.stringify(mockTriage(request.text)),
      source: "MOCK",
      model: this.cloudModel
    };
  }
}
