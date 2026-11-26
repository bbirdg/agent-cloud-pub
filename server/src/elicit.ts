import {
  CLIENT_CAPABILITIES_META_KEY,
  type CallToolResult,
  type ClientCapabilities,
  type InputRequiredResult,
  type RequestStateCodec,
  type ServerContext,
  acceptedContent,
  createRequestStateCodec,
  inputRequired,
  inputResponse,
} from "@modelcontextprotocol/server";
import { getMcpAuthContext } from "agents/mcp/server";
import { z } from "zod";
import { MemoryError } from "./memory";

/**
 * Asking the user to confirm an action mid-call, over the 2026-07-28 multi-round-trip flow: the tool returns
 * `input_required` with a form, the client shows it and calls the tool again with the answer. Clients that cannot
 * show a form (2025-era clients, which this stateless Worker cannot push requests to, and clients that did not
 * declare elicitation) get a plain-text request to confirm in chat and call again with confirm=true.
 */

/** What the first round asked about; echoed back signed, so the answer can only confirm that exact action. */
export interface ConfirmState {
  tool: string;
  subject: string;
}

const confirmSchema = z.object({ confirm: z.boolean().meta({ title: "Yes, do it" }) });

let cached: { secret: string; codec: RequestStateCodec<ConfirmState> } | undefined;

/** The requestState codec, or null when MCP_STATE_SECRET is missing or shorter than 32 bytes. */
export function stateCodec(secret: string | undefined): RequestStateCodec<ConfirmState> | null {
  if (!secret || new TextEncoder().encode(secret).byteLength < 32) return null;
  if (cached?.secret !== secret) {
    cached = {
      secret,
      codec: createRequestStateCodec<ConfirmState>({
        key: secret,
        ttlSeconds: 600,
        // Bound to the caller's stable identity (device id or GitHub user id), not a display name that two
        // devices could share: state minted for one device or sign-in is refused for another.
        bind: (ctx) => {
          const props = getMcpAuthContext()?.props as { kind?: string; id?: string; name?: string } | undefined;
          return `${ctx.mcpReq.method}\0${props?.kind ?? ""}\0${props?.id ?? props?.name ?? ""}`;
        },
      }),
    };
  }
  return cached.codec;
}

/** Whether this request can carry a form elicitation (modern era, and the client declared form support). */
function canElicit(ctx: ServerContext): boolean {
  const envelope = ctx.mcpReq.envelope as Record<string, unknown> | undefined;
  const caps = envelope?.[CLIENT_CAPABILITIES_META_KEY] as ClientCapabilities | undefined;
  const elicitation = caps?.elicitation as { form?: unknown; url?: unknown } | undefined;
  if (!elicitation) return false;
  // A bare `elicitation: {}` means form support (the pre-mode meaning); url-only clients cannot show a form.
  return elicitation.form !== undefined || elicitation.url === undefined;
}

export type Confirmation = { confirmed: true } | { confirmed: false; reply: CallToolResult | InputRequiredResult };

const say = (text: string): CallToolResult => ({ content: [{ type: "text", text }] });

/**
 * Asks the user to confirm `subject` for `tool`, or reads their answer on the retry.
 * `confirmArg` (the tool's confirm=true argument) only counts when the client cannot show a form, so a model can
 * never skip a form the user would have seen.
 */
export async function confirmAction(
  ctx: ServerContext,
  codec: RequestStateCodec<ConfirmState>,
  input: {
    tool: string;
    subject: string;
    message: string;
    confirmArg?: boolean;
    /**
     * Without a form, a "yes in chat" is only the model's word. When this returns text, the chat route is refused
     * with it (e.g. "only after 24 hours in the bin") instead of trusting confirm=true.
     */
    refuseWithoutForm?: () => string | null;
  },
): Promise<Confirmation> {
  if (!canElicit(ctx)) {
    const refusal = input.refuseWithoutForm?.();
    if (refusal) return { confirmed: false, reply: say(refusal) };
    if (input.confirmArg === true) return { confirmed: true };
    return {
      confirmed: false,
      reply: say(
        `Not done yet: this needs the user's explicit confirmation. Ask the user in chat: "${input.message}" Only if they clearly say yes, call ${input.tool} again with the same arguments and confirm=true.`,
      ),
    };
  }

  const ask = async () => ({
    confirmed: false as const,
    reply: inputRequired({
      inputRequests: { confirm: inputRequired.elicit({ message: input.message, requestedSchema: confirmSchema }) },
      requestState: await codec.mint({ tool: input.tool, subject: input.subject }, ctx),
    }),
  });

  // The SDK has already verified the signature, expiry and caller binding (or refused the call with -32602).
  const state = ctx.mcpReq.requestState<ConfirmState>();
  if (state === undefined) return ask();
  if (typeof state !== "object" || state.tool !== input.tool || state.subject !== input.subject) {
    throw new MemoryError("This confirmation was for a different request or an older version of the note. Nothing was changed; start again.");
  }
  const view = inputResponse(ctx.mcpReq.inputResponses, "confirm");
  if (view.kind === "missing") return ask();
  if (view.kind === "elicit" && view.action !== "accept") {
    return { confirmed: false, reply: say(`Cancelled: the user ${view.action === "decline" ? "declined" : "dismissed the question"}. Nothing was changed.`) };
  }
  const answer = acceptedContent(ctx.mcpReq.inputResponses, "confirm", confirmSchema);
  if (answer === undefined) return ask();
  if (!answer.confirm) return { confirmed: false, reply: say("Cancelled: the user did not confirm. Nothing was changed.") };
  return { confirmed: true };
}
