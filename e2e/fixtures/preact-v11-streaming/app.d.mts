import type { ComponentType, VNode } from "preact";

export interface ExperimentConfig {
  clientDelay: number;
  mode: "hydration-2" | "stream";
  serverDelay: number;
}

export function createExperimentApp(config: ExperimentConfig): ComponentType;
export function createDocument(config: ExperimentConfig): VNode;
