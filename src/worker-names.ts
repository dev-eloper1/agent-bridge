// A conversation keeps its first task's name; fresh conversations reserve a
// distinct name even when they have the same provider and description.
export function workerName(
  agentId: string,
  description: string,
  reserved: Iterable<string>,
) {
  const slug = (value: string) =>
    value
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
  const provider = slug(agentId.replace(/-(worker|reviewer)$/, "")) || "worker";
  const topic = slug(description) || "task";
  const base = `${provider}-${topic}`.slice(0, 60).replace(/-$/, "");
  const used = new Set(reserved);
  let name = base;
  for (let n = 2; used.has(name); n++) name = `${base}-${n}`;
  return name;
}
