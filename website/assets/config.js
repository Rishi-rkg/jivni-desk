// Everything that changes without touching a page lives here:
// where downloads come from, where the web app is, and every piece of
// borrowed media with its attribution. The credits page is built from MEDIA.
window.JIVNI = {
  // GitHub repository whose releases the download page reads. Release files
  // are only downloadable by the public if this repository is public.
  releasesRepo: "Rishi-rkg/Jivni",
  appUrl: "https://jivnidesk.app",

  // Background videos. Give each a src (an .mp4, ideally also a .webm) and a
  // poster image; with no src the animated placeholder shows instead.
  // One is picked per page load. A video joined from several clips lists
  // them under clips so that each is credited.
  videos: [
    {
      id: "backdrop-1",
      src: "assets/media/backdrop.mp4",
      webm: "assets/media/backdrop.webm",
      poster: "assets/media/backdrop-poster.jpg",
      // Three seconds of each, in this order, at 1280 x 720.
      clips: [
        { title: "Mother and child resting together", author: "Vlada Karpovich", source: "https://www.pexels.com/video/kids-mother-family-brother-4628700/", license: "Pexels License" },
        { title: "Mother and kid hugging", author: "olia danilevich", source: "https://www.pexels.com/video/mother-and-kid-hugging-5487370/", license: "Pexels License" },
        { title: "Woman mixing flower essence", author: "Anna Shvets", source: "https://www.pexels.com/video/woman-mixing-flower-essence-5756175/", license: "Pexels License" },
        { title: "A person putting liquid in bottles", author: "Anna Shvets", source: "https://www.pexels.com/video/a-person-putting-liquid-in-cosmetic-bottles-5893534/", license: "Pexels License" },
        { title: "Woman at a reception desk", author: "Pavel Danilyuk", source: "https://www.pexels.com/video/woman-at-reception-desk-pointing-to-her-teeth-6192976/", license: "Pexels License" },
        { title: "Close-up of people holding hands", author: "Kampus Production", source: "https://www.pexels.com/video/close-up-of-people-holding-hands-8871836/", license: "Pexels License" },
      ],
    },
  ],

  // What doctors say, shown on the home page. Entries marked sample are
  // stand-ins and are labelled as such on the page; replace them with real
  // words and remove the mark.
  testimonials: [
    { sample: true, quote: "A doctor's own words about using Jivni in their clinic will go here.", name: "Doctor's name", place: "Clinic, city" },
    { sample: true, quote: "A second voice, perhaps from the front desk: what changed in their day.", name: "Name", place: "Role, clinic" },
    { sample: true, quote: "A third, from a clinic with more than one branch.", name: "Doctor's name", place: "Clinic, city" },
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
