export const ToolGraphRelation = {
  SimilarTo: "similar_to",
  DependsOn: "depends_on",
  Requires: "requires",
  AlternativeTo: "alternative_to",
  CombineWith: "combine_with",
  Supersede: "supersede",
  ConflictWith: "conflict_with",
  ChildOf: "child_of",
} as const;

export type ToolGraphRelation =
  (typeof ToolGraphRelation)[keyof typeof ToolGraphRelation];

export const TOOL_GRAPH_RELATION_TYPES: ToolGraphRelation[] = [
  ToolGraphRelation.SimilarTo,
  ToolGraphRelation.DependsOn,
  ToolGraphRelation.Requires,
  ToolGraphRelation.AlternativeTo,
  ToolGraphRelation.CombineWith,
  ToolGraphRelation.Supersede,
  ToolGraphRelation.ConflictWith,
  ToolGraphRelation.ChildOf,
];

export function normalizeGraphRelation(raw: string): ToolGraphRelation | null {
  const value = raw.trim().toLowerCase();
  return TOOL_GRAPH_RELATION_TYPES.find((type) => type === value) ?? null;
}
