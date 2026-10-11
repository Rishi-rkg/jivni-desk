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

  // Photographs. Pages refer to them by id with data-media="id". With no src
  // the slot shows a labelled placeholder. An entry marked generated was made
  // with that image model and is credited as such; a stock photograph has
  // author, source and license instead.
  images: [
    {
      id: "clinic-desk",
      src: "assets/media/clinic-desk.jpg",
      generated: "Z-Image Turbo",
      alt: "A doctor's desk with a laptop, remedy bottles and paper envelopes",
      brief: "Doctor's desk: laptop, remedy bottles, paper envelopes",
      author: null,
      source: null,
      license: null,
    },
    {
      id: "reception",
      src: "assets/media/reception.jpg",
      generated: "Z-Image Turbo",
      alt: "A small clinic reception with a patient being greeted",
      brief: "Small clinic reception, a patient being greeted",
      author: null,
      source: null,
      license: null,
    },
    {
      id: "remedies",
      src: "assets/media/remedies.jpg",
      generated: "Z-Image Turbo and Qwen Image Edit",
      alt: "Glass vials of homeopathic globules beside a labelled paper envelope",
      brief: "Vials of globules beside a labelled envelope",
      author: null,
      source: null,
      license: null,
    },
    {
      // The owner traced the source image on 2026-10-11 and found it is
      // Creative Commons with no attribution required. Credited anyway.
      id: "doctor-scan",
      src: "assets/media/doctor-scan.jpg",
      alt: "A doctor pointing a handheld barcode scanner at a small paper envelope",
      brief: "Doctor scanning a prescription envelope",
      author: "the photographer of the source image, as published on mobiletransaction.org",
      source: "https://www.mobiletransaction.org/wp-content/uploads/2022/05/barcode-scanner-retail-example.jpg",
      license: "Creative Commons, no attribution required",
      edited: "clothing, item and background replaced with Qwen Image Edit",
    },
    {
      id: "reception-scan",
      src: "assets/media/reception-scan.jpg",
      alt: "A clinic receptionist handing a customer a small paper bag over the counter",
      brief: "Customer receiving an order at a counter",
      author: "SpotOn POS",
      source: "https://www.pexels.com/photo/customer-in-cafe-receiving-takeout-order-at-counter-37594417/",
      license: "Pexels License",
      edited: "background, outfit and items replaced with Qwen Image Edit",
    },
    {
      id: "visit",
      src: "assets/media/visit.jpg",
      generated: "Z-Image Turbo and Qwen Image Edit",
      alt: "A doctor listening to a mother and her daughter",
      brief: "Doctor in conversation with a mother and child",
    },
    {
      id: "messages",
      src: "assets/media/messages.jpg",
      generated: "Z-Image Turbo",
      alt: "A patient reading a message on her phone at home",
      brief: "Patient reading a message on her phone",
    },
    {
      id: "library",
      src: "assets/media/library.jpg",
      alt: "A doctor working at a laptop with a notebook, shelves of remedy bottles behind him",
      brief: "Man in eyeglasses using a laptop while holding a pen",
      author: "Arina Krasnikova",
      source: "https://www.pexels.com/photo/man-in-eyeglasses-using-a-laptop-while-holding-a-pen-5710662/",
      license: "Pexels License",
      edited: "background replaced with Qwen Image Edit",
    },
    {
      id: "backup",
      src: "assets/media/backup.jpg",
      generated: "Z-Image Turbo",
      alt: "A laptop with an external drive and a padlock on a desk",
      brief: "Laptop, backup drive and padlock",
    },
    {
      id: "envelope",
      src: "assets/media/envelope.jpg",
      generated: "Z-Image Turbo and Qwen Image Edit",
      alt: "A small paper envelope with a printed dosage label beside glass vials of globules",
      brief: "Labelled envelope beside vials of globules",
    },
  ],
};
