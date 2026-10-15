# Github Html Preview Extension<img src="https://github.com/user-attachments/assets/8c016bed-4378-40e1-9781-19668dc73da9" align=left width=100>

![GitHub License](https://img.shields.io/github/license/dohyeon5626/github-html-preview-extension?style=flat&color=green) ![GitHub Tag](https://img.shields.io/github/v/tag/dohyeon5626/github-html-preview-extension?style=flat&color=green`) ![Chrome Web Store Version](https://img.shields.io/chrome-web-store/v/pmpjligbgooljdpakhophgddmcipglna?style=flat&color=blue&label=deploy%20version) ![Chrome Web Store Users](https://img.shields.io/chrome-web-store/users/pmpjligbgooljdpakhophgddmcipglna?style=flat&label=users&color=blue)
<br/><br/>

[Chrome Web Store](https://chromewebstore.google.com/detail/github-html-preview/pmpjligbgooljdpakhophgddmcipglna) | [Youtube](https://www.youtube.com/watch?v=1ILDesSpFls)

<img width="100%" align=center alt="readme" src="https://github.com/user-attachments/assets/4fcbc81f-f4a7-4bb9-b3f8-5b58533fdf4c">
<br/><br/>

This Chrome extension allows you to instantly preview HTML files on GitHub. With a single click, you can see the rendered HTML in a new tab, and it also supports private repositories when configured with your GitHub token.<br/>
- Instant Preview: Click the preview button on any GitHub HTML page to see the rendered results in a new tab.
- Private Repository Support: Configure your GitHub token to preview HTML files in private repositories.
- Pull Request Diff Preview: On a pull request's "Files changed" page (also commit-range and single-commit views), every `.html` file gets a **Preview** button. It renders the file inline with additions outlined in **green**, changed elements outlined in amber, and every deletion shown as a red **−** bubble you can click to see what was removed (rendered and as HTML source). Toggle **Side by side** for a before/after view with synced scrolling, and use the arrows to jump between changes.
  - Scripts and inline event handlers are stripped from the previewed HTML, so untrusted PR content never runs; the page is rendered in a sandboxed frame.
  - Repo-relative stylesheets are inlined and relative images/links resolve against GitHub. Images in private repositories won't load.
  - Content is fetched from the GitHub API; add a token in the popup (or log in) for private repositories or to avoid the anonymous rate limit.
- Quick Access: Use Ctrl + Shift + Y (Windows/Linux) or Command + Shift + Y (Mac), or right-click and select "Preview HTML" from the context menu to open the preview.

> Works with [Github Html Preview Page](https://github.com/dohyeon5626/github-html-preview-page), [Serverless Functions](https://github.com/dohyeon5626/serverless-functions/tree/main/github-html-preview)
