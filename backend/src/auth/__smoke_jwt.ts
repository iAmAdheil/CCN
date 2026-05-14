// npx tsx src/auth/__smoke_jwt.ts
// Verifies the JWT helpers in isolation. No HTTP, no nodemailer.

process.env.AUTH_JWT_SECRET = "test-secret-at-least-16-chars";

const { signMagicLink, signSession, verifyToken, isJtiRedeemed, markJtiRedeemed } =
  await import("./jwt.js");

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    pass++;
    console.log("  PASS", name);
  } else {
    fail++;
    console.error("  FAIL", name);
  }
}

console.log("auth/jwt smoke");

// 1. magic link round trip
{
  const { token, jti } = signMagicLink("alice@example.com");
  check("magic token shape", token.split(".").length === 3);
  const claims = verifyToken(token, "magic");
  check("magic decodes back to email", claims.sub === "alice@example.com");
  check("jti consistent", claims.jti === jti);
}

// 2. session round trip
{
  const { token, jti } = signSession("bob@example.com");
  const claims = verifyToken(token, "session");
  check("session decodes", claims.sub === "bob@example.com" && claims.jti === jti);
}

// 3. kind mismatch is rejected
{
  const { token } = signMagicLink("c@d.e");
  let threw = false;
  try {
    verifyToken(token, "session");
  } catch {
    threw = true;
  }
  check("magic token can't pass as session", threw);
}

// 4. redeemed jti tracking
{
  check("jti not redeemed initially", !isJtiRedeemed("aaa"));
  markJtiRedeemed("aaa");
  check("jti redeemed after mark", isJtiRedeemed("aaa"));
  check("unrelated jti still fresh", !isJtiRedeemed("bbb"));
}

// 5. tampered token rejected
{
  const { token } = signSession("eve@example.com");
  // Flip a single character in the payload.
  const parts = token.split(".");
  const broken = parts[0]! + "." + parts[1]!.replace(/.$/, "X") + "." + parts[2]!;
  let threw = false;
  try {
    verifyToken(broken, "session");
  } catch {
    threw = true;
  }
  check("tampered token rejected", threw);
}

console.log(`\nResult: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
