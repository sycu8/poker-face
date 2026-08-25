/** Pure join-request coalescing used by /api/rooms/join-request. */
export function coalesceJoinRequest(args: {
  memberStatus: string | null | undefined;
  pendingRequestId: string | null | undefined;
  newRequestId: string;
}):
  | { status: "approved"; message: string }
  | { status: "pending"; requestId: string; message: string } {
  if (args.memberStatus === "seated") {
    return { status: "approved", message: "You have a seat" };
  }
  if (args.pendingRequestId) {
    return {
      status: "pending",
      requestId: args.pendingRequestId,
      message: "Waiting for the host",
    };
  }
  return {
    status: "pending",
    requestId: args.newRequestId,
    message: "Waiting for the host",
  };
}
