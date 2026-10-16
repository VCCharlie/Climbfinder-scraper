/**
 * Run: node cplClient.test.js
 */
const assert = require("assert");
const { googleProviderUidFromAuth, authIdentityFromContext } = require("./cplClient");

const ctx = {
  auth: {
    token: {
      email: "VR.DERuiter@gmail.com",
      firebase: { identities: { "google.com": ["1234567890"] } },
    },
  },
};

assert.strictEqual(authIdentityFromContext(ctx).email, "vr.deruiter@gmail.com");
assert.strictEqual(googleProviderUidFromAuth(ctx.auth), "1234567890");

console.log("cplClient.test.js OK");
