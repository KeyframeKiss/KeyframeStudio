// Wire types — mirror plugin/StudioBridge/src/Api/*.cs

export interface Hello {
  plugin: string;
  protocol: number;
  game: string;
  unity: string;
  timeline: boolean;
  translator: boolean;
  /** Mod-dependent features and whether they work with what's installed (missing in older plugins). */
  features?: Feature[];
  paths?: { game: string; userData: string; bepinexLog: string };
  commands: string[];
}

export interface Feature {
  id: string;
  label: string;
  mod: string;
  guid: string;
  version: string | null;
  tested: string[];
  /** ok · untested (works, version not tested) · off (incompatible) · missing (not installed) */
  status: 'ok' | 'untested' | 'off' | 'missing';
  reason: string | null;
}

export type NodeType = 'Char' | 'Item' | 'Light' | 'Folder' | 'Route' | 'RoutePoint' | 'Camera' | 'node' | string;

export interface SceneNode {
  id: number;
  name: string;
  nameEn?: string;
  type: NodeType;
  visible: boolean;
  open: boolean;
  children: number[];
  sex?: number;
}

export interface SceneData {
  fileName?: string | null;
  roots: number[];
  nodes: SceneNode[];
  selected: number[];
}

export interface TimelineState {
  playing: boolean;
  time: number;
  duration: number;
  fps: number;
  speed: number;
  uiVisible: boolean;
}

/** [t] or [t, curve] where curve is flattened [time, value, inTangent, outTangent]* (absent = linear). */
export type WireKey = [number] | [number, number[]];

export interface WireTrack {
  id: number;
  name: string;
  nameEn?: string;
  alias: string;
  owner: string;
  model: string;
  oci: number;
  enabled: boolean;
  color: [number, number, number];
  group: number;
  order?: number;
  keys: WireKey[];
}

export interface WireGroup {
  id: number;
  parent: number;
  name: string;
  expanded: boolean;
  order?: number;
}

export interface TimelineData extends TimelineState {
  groups: WireGroup[];
  tracks: WireTrack[];
}

export interface TrackModel {
  owner: string;
  id: string;
  name: string;
  nameEn?: string;
}

export interface KeyInfo {
  t: number;
  value: Record<string, string>;
  curve: number[];
}

export interface KeyRef {
  track: number;
  t: number;
}
