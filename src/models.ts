export interface DiscoveredModels {
  currentModelId?: string;
  availableModels: { modelId: string; name: string }[];
}
// ACP providers may report the legacy models field, or a categorized select config option.
export function discoverModels(value: {
  models?: unknown;
  configOptions?: unknown;
}): DiscoveredModels | undefined {
  const legacy = value.models as DiscoveredModels | undefined;
  if (legacy?.availableModels) return legacy;
  if (!Array.isArray(value.configOptions)) return;
  const model = value.configOptions.find(
    (x) => x.category === "model" || x.id === "model",
  );
  if (!model || model.type !== "select") return;
  function flatten(options: any[]): { modelId: string; name: string }[] {
    return options.flatMap((o) =>
      Array.isArray(o.options)
        ? flatten(o.options)
        : typeof o.value === "string"
          ? [{ modelId: o.value, name: String(o.name ?? o.value) }]
          : [],
    );
  }
  return {
    currentModelId:
      typeof model.currentValue === "string" ? model.currentValue : undefined,
    availableModels: flatten(model.options ?? []),
  };
}
