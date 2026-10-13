// Bounds asynchronous agent work. A timeout prevents late results being committed;
// an in-process agent's own side effects cannot be cancelled by this wrapper.
export async function withDeadline(work, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(work),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('Agent 响应超时，请重试'), { status: 504 })), timeoutMs);
      }),
    ]);
  } finally { clearTimeout(timer); }
}
