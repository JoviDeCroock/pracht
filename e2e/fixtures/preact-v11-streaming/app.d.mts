import type { ComponentType, VNode } from "preact";

export interface ExperimentConfig {
  /** Server-side delay for the `<body>` boundary in `head-body` mode. */
  bodyDelay?: number;
  clientDelay: number;
  /** Server-side delay for the `<head>` boundary in `head-body` mode. */
  headDelay?: number;
  mode: "head-body" | "hydration-2" | "shell-head" | "stream";
  serverDelay: number;
}

export function createExperimentApp(config: ExperimentConfig): ComponentType;
export function createHeadBodyApp(config: ExperimentConfig): ComponentType;
export function createShellHeadApp(config: ExperimentConfig): ComponentType;
export function createDocument(config: ExperimentConfig): VNode;
