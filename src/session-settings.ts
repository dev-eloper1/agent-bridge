export interface SessionSettingChoice {
  value: string;
  name: string;
  description?: string;
}
export interface SessionSettingOption {
  id: string;
  name: string;
  description?: string;
  category?: string;
  type: "select" | "boolean";
  currentValue: string | boolean;
  choices?: SessionSettingChoice[];
  source: "config_option" | "legacy_mode";
}
const MAX_OPTIONS = 50;
const MAX_CHOICES = 100;
const MAX_ID = 100;
const MAX_NAME = 120;
const MAX_DESCRIPTION = 500;
const MAX_VALUE = 200;
function text(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= max
    ? value
    : undefined;
}
function identifier(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  return text(record.id, MAX_ID) ?? text(record.configId, MAX_ID);
}
function flattenChoices(raw: unknown, out: SessionSettingChoice[]) {
  if (!Array.isArray(raw)) return;
  for (const entry of raw) {
    if (out.length >= MAX_CHOICES) return;
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    if (Array.isArray(record.options)) {
      flattenChoices(record.options, out);
      continue;
    }
    const value = text(record.value, MAX_VALUE);
    if (value === undefined) continue;
    const choice: SessionSettingChoice = {
      value,
      name: text(record.name, MAX_NAME) ?? value,
    };
    const description = text(record.description, MAX_DESCRIPTION);
    if (description) choice.description = description;
    out.push(choice);
  }
}
export function normalizeSessionSettings(value: {
  configOptions?: unknown;
  modes?: unknown;
}): SessionSettingOption[] {
  const options: SessionSettingOption[] = [];
  const seen = new Set<string>();
  if (Array.isArray(value.configOptions))
    for (const raw of value.configOptions) {
      if (options.length >= MAX_OPTIONS) break;
      if (!raw || typeof raw !== "object") continue;
      const record = raw as Record<string, unknown>;
      const id = identifier(record);
      if (!id || seen.has(id)) continue;
      const isBoolean =
        record.type === "boolean" || typeof record.currentValue === "boolean";
      let option: SessionSettingOption | undefined;
      if (isBoolean) {
        if (typeof record.currentValue !== "boolean") continue;
        option = {
          id,
          name: text(record.name, MAX_NAME) ?? id,
          type: "boolean",
          currentValue: record.currentValue,
          source: "config_option",
        };
      } else if (record.type === "select" || Array.isArray(record.options)) {
        const currentValue = text(record.currentValue, MAX_VALUE);
        if (currentValue === undefined) continue;
        const choices: SessionSettingChoice[] = [];
        flattenChoices(record.options, choices);
        if (!choices.length) continue;
        option = {
          id,
          name: text(record.name, MAX_NAME) ?? id,
          type: "select",
          currentValue,
          choices,
          source: "config_option",
        };
      }
      if (!option) continue;
      const description = text(record.description, MAX_DESCRIPTION);
      if (description) option.description = description;
      const category = text(record.category, MAX_NAME);
      if (category) option.category = category;
      seen.add(id);
      options.push(option);
    }
  if (
    options.length < MAX_OPTIONS &&
    !options.some((o) => o.id === "mode" || o.category === "mode")
  ) {
    const modes = value.modes as Record<string, unknown> | undefined;
    const available = Array.isArray(modes?.availableModes)
      ? (modes!.availableModes as Record<string, unknown>[])
      : [];
    const choices: SessionSettingChoice[] = [];
    for (const m of available) {
      if (choices.length >= MAX_CHOICES) break;
      const id = text(m?.id, MAX_VALUE);
      if (!id) continue;
      const choice: SessionSettingChoice = {
        value: id,
        name: text(m?.name, MAX_NAME) ?? id,
      };
      const description = text(m?.description, MAX_DESCRIPTION);
      if (description) choice.description = description;
      choices.push(choice);
    }
    const currentModeId = text(modes?.currentModeId, MAX_VALUE);
    if (choices.length && choices.some((c) => c.value === currentModeId))
      options.push({
        id: "mode",
        name: "Mode",
        category: "mode",
        type: "select",
        currentValue: currentModeId!,
        choices,
        source: "legacy_mode",
      });
  }
  return options;
}
export function validateSessionSetting(
  options: SessionSettingOption[],
  configId: string,
  value: string | boolean,
): SessionSettingOption {
  const option = options.find((o) => o.id === configId);
  if (!option)
    throw Error(
      `Session option "${configId}" is not advertised (available: ${
        options.map((o) => o.id).join(", ") || "none"
      })`,
    );
  if (option.type === "boolean") {
    if (typeof value !== "boolean")
      throw Error(`Session option "${configId}" expects a boolean value`);
  } else {
    const allowed = (option.choices ?? []).map((c) => c.value);
    if (typeof value !== "string" || !allowed.includes(value))
      throw Error(
        `Session option "${configId}" must be one of: ${
          allowed.join(", ") || "none advertised"
        }`,
      );
  }
  return option;
}
