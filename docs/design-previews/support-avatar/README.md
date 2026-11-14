# Support avatar

Browser-only proposal for renaming the built-in support contact and giving it the Kordi bird with a question mark. Every option keeps the ink paper-cut bird and amber beak on white, as the current support avatar does, and shows at the Mac contact row, profile header and chat sizes, plus the iPhone contact row and profile.

- A: the wing cut becomes a question mark cut through the body.
- B: the wing stays and a small question mark is cut above it.
- C: the bird steps back and an amber question mark sits beside its head.
- D: the wing becomes an amber question mark. D was chosen, with the name KordiSpot.

Data is synthetic and nothing connects to an API. Serve it bound to loopback, then open `http://127.0.0.1:8773/`:

```sh
cd docs/design-previews/support-avatar
python3 -m http.server 8773 --bind 127.0.0.1
```

| Parameter | Values | Default |
| --- | --- | --- |
| `option` | `a`, `b`, `c`, `d` | `d` |
| `name` | `KordiSpot`, `KordiSupport` | `KordiSpot` |
| `theme` | `light`, `dark` | `light` |
