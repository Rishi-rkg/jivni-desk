// Everything that changes without touching a page lives here:
// where downloads come from, where the web app is, and every piece of
// borrowed media with its attribution. The credits page is built from MEDIA.
window.JIVNI = {
  // GitHub repository whose releases the download page reads. Release files
  // are only downloadable by the public if this repository is public.
  releasesRepo: "Rishi-rkg/Jivni",
  appUrl: "https://jivnidesk.app",

  // Background videos. Give each a src (an .mp4, ideally also a .webm) and a
  // poster image; while src is null the animated placeholder shows instead.
  // One is picked per page load.
  videos: [
    {
      id: "backdrop-1",
      src: null,
      webm: null,
      poster: null,
      title: "Placeholder background",
      author: null,
      source: null,
      license: null,
    },
  ],

  // Stock photographs. Pages refer to them by id with data-media="id".
  // While src is null the slot shows a labelled placeholder.
  images: [
    {
      id: "clinic-desk",
      src: null,
      alt: "A doctor's desk with a laptop, remedy bottles and paper envelopes",
      brief: "Doctor's desk: laptop, remedy bottles, paper envelopes",
      author: null,
      source: null,
      license: null,
    },
    {
      id: "reception",
      src: null,
      alt: "A small clinic reception with a patient being greeted",
      brief: "Small clinic reception, a patient being greeted",
      author: null,
      source: null,
      license: null,
    },
    {
      id: "remedies",
      src: null,
      alt: "Glass vials of homeopathic globules on a shelf",
      brief: "Glass vials of globules on a shelf, close up",
      author: null,
      source: null,
      license: null,
    },
  ],
};
