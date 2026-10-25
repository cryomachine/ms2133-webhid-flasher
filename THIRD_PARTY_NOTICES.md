# Third-Party Notices

This file covers third-party code used by the browser source project. The
project bundles the owner-selected factory image for the factory restore task.
That image is vendor firmware and is not covered by the source code's MIT
license. Other device backups and local launcher binaries are not distributed.

## MS213x HID protocol

The HID protocol implementation is derived from Steve Markgraf's
`ms213x_flash`, commit `407660584af332348dba3f538caedb0884871b62`:
https://github.com/steve-m/ms213x_flash

Copyright (C) 2026 by Steve Markgraf <steve@steve-m.de>

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be included
in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## React, React DOM and Scheduler

The browser application uses [React](https://github.com/facebook/react):
`react`, `react-dom`, and the transitive runtime dependency `scheduler`.
These packages are licensed under MIT.

```text
Copyright (c) Meta Platforms, Inc. and affiliates.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## JavaScript and TypeScript build dependencies

The lockfile records the exact installed dependency versions. Direct build
and type dependencies use the following licenses:

| Package | License | Upstream |
| --- | --- | --- |
| `@types/react`, `@types/react-dom` | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| `@vitejs/plugin-react` | MIT | https://github.com/vitejs/vite-plugin-react |
| `vite` | MIT | https://github.com/vitejs/vite |
| `typescript` | Apache-2.0 | https://github.com/microsoft/TypeScript |
| `esbuild` | MIT | https://github.com/evanw/esbuild |

Transitive development dependencies retain their own license files in the
installed npm packages. Those tools are not vendored as project source.
When redistributing dependency packages or a modified build that embeds
additional dependency code, retain their applicable copyright notices and
licenses. TypeScript's license text is available at
https://github.com/microsoft/TypeScript/blob/main/LICENSE.txt.
