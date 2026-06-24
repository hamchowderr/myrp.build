# The code you generate is yours

myRP.build is a code generator. When you describe a resource and the app writes
Lua, `fxmanifest.lua`, SQL, and NUI files into your server's
`resources/[local]/<name>/`, **that generated output is yours.**

- **We claim no copyright or license over what you generate.** Use it, modify
  it, ship it on your server, sell access to your server, or include it in a
  paid resource — no attribution to myRP.build required, no royalty, no
  strings.
- **The license on myRP.build itself does not reach your output.** The
  [Functional Source License](../LICENSE) covers the *app* (the generator). It
  does **not** cover the *resources the app generates for you* — those are a
  product of your prompts and your server, and they belong to you.
- **You are responsible for what you ship.** Generated code is provided "as is."
  Review it, test it, and make sure it fits your server and your players before
  you go live — especially anything touching money, permissions, or player
  data. See the [Disclaimer in the LICENSE](../LICENSE).

### What about ox?

Generated resources call the **ox_overextended** ecosystem (`ox_core`,
`ox_lib`, `ox_inventory`, `ox_target`, `oxmysql`) through its **public
exports** — the same way any FiveM resource does. myRP.build never copies ox's
own source into your output, so ox's licenses apply to ox, and your generated
resource is your own work that merely *uses* ox at runtime. Install ox the
normal way and follow its licenses for the ox resources themselves.
