import { z } from "zod";
import { ApiError, parseBody, route } from "@/lib/server/api";
import { cancelRun, decideApproval, getController, getRunRow, startRun, type RunSnapshot } from "@/lib/server/agents/runner";
import { requireAccount } from "@/lib/server/session";

const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("pause") }),
  z.object({ action: z.literal("resume") }),
  z.object({ action: z.literal("cancel") }),
  z.object({
    action: z.literal("approve"),
    approve: z.array(z.string().min(1).max(200)).max(50).default([]),
    reject: z.array(z.string().min(1).max(200)).max(50).default([]),
  }),
  z.object({ action: z.literal("rerun") }),
]);

type Ctx = { params: Promise<{ id: string }> };

export const POST = route<Ctx>(async (req, ctx) => {
  const account = await requireAccount();
  const id = (await ctx.params).id;
  const body = await parseBody(req, bodySchema);
  const row = getRunRow(account.id, id);

  switch (body.action) {
    case "pause":
      if (!getController(id)?.pause()) throw new ApiError(409, "not_running", "Only a running run can be paused.");
      return { ok: true };
    case "resume":
      if (!getController(id)?.resume()) throw new ApiError(409, "not_paused", "This run is not paused.");
      return { ok: true };
    case "cancel":
      cancelRun(account.id, id);
      return { ok: true };
    case "approve": {
      const overlap = body.approve.filter((callId) => body.reject.includes(callId));
      if (overlap.length) throw new ApiError(400, "invalid_input", "A tool call cannot be both approved and rejected.");
      if (body.approve.length + body.reject.length === 0) throw new ApiError(400, "invalid_input", "No decisions were given.");
      decideApproval(account.id, account.apiKey(), id, { approve: body.approve, reject: body.reject });
      return { ok: true };
    }
    case "rerun": {
      // Same frozen agent definitions and the same input as the original.
      const newId = startRun({
        accountId: account.id,
        apiKey: account.apiKey(),
        snapshot: row.snapshot as unknown as RunSnapshot,
        input: row.input,
        agentId: row.agentId,
        replayOf: row.id,
      });
      return { id: newId };
    }
  }
});
