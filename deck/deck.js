/* Reveal setup for the migration deep dive deck. Classic script (not a module) so the
   deck runs straight from file://. Shared by index.html and the QA fixtures.

   Keys: S opens the speaker view (notes plugin), T flips light/dark theme.
   ?theme=dark or ?theme=light in the URL picks a theme at load. */
(function () {
  var root = document.documentElement;
  var asked = new URLSearchParams(location.search).get('theme');
  if (asked === 'dark' || asked === 'light') root.dataset.theme = asked;

  function toggleTheme() {
    var dark = root.dataset.theme
      ? root.dataset.theme === 'dark'
      : matchMedia('(prefers-color-scheme: dark)').matches;
    root.dataset.theme = dark ? 'light' : 'dark';
  }

  Reveal.initialize({
    width: 1280,
    height: 720,
    margin: 0,            // 1280x720 projector renders at scale 1 (QA measures at that size)
    minScale: 0.2,
    maxScale: 2.0,
    center: false,
    display: 'flex',
    hash: true,
    navigationMode: 'linear',   // a clicker walks every slide in order, stacks included
    controls: false,
    progress: true,
    slideNumber: 'c/t',
    transition: 'fade',
    transitionSpeed: 'fast',
    backgroundTransition: 'none',
    keyboard: { 84: toggleTheme },
    plugins: [RevealNotes]
  });
})();
