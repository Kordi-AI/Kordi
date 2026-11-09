# Card references

Browser-only proposal for how a card topic shows its references (issue #2400). Option A lists one line per reference that expands in place; option B shows the references as chips with one detail panel under them. B was chosen and is what the Mac card page and the iPhone topic page now use. Data is synthetic and nothing connects to an API.

Serve it bound to loopback, then open `http://127.0.0.1:8724/`:

```sh
cd docs/design-previews/card-references
python3 -m http.server 8724 --bind 127.0.0.1
```
