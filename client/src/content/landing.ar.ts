import type { LandingContent } from "./types";

/**
 * / — Arabic.
 *
 * STATUS: MACHINE-DRAFTED MSA. NOT REVIEWED. Same standing as the other .ar
 * modules — see docs/GLOSSARY_ARABIC.md.
 *
 * Uses the glossary as it stands: صانع المحتوى (creator), العلامة التجارية
 * (brand), مساحة (surface — the one place English and Arabic deliberately
 * diverge in imagery, see §4), التسويق المُدمج (product placement, see
 * unsettled placeholder).
 *
 * NOTES FOR THE COPYWRITER, specific to this page:
 *
 *  · `features.titles` and `backers.names` are zipped to IMAGES by index.
 *    Keep both lists the same length and order. Backer names are companies
 *    and stay in Latin script.
 *
 *  · Several headings are split into `titleLead` + `titleAccent` because the
 *    accent half renders in a different colour mid-sentence. Arabic word
 *    order will not always put the emphasised words in the same place —
 *    move them between the two fields as the sentence needs, rather than
 *    translating each half in isolation.
 *
 *  · "We Turn Storytelling Into Revenue" is close to a tagline. A literal
 *    rendering is weaker than a rewrite; treat it as a line to be written,
 *    not translated.
 */
export const landingAr: LandingContent = {
  nav: {
    logoAlt: "بوابة FullScale لصناع المحتوى",
    wordmark: "FullScale",
    forBrands: "للعلامات التجارية",
    signIn: "تسجيل الدخول",
  },

  hero: {
    badge: "إعادة بناء المشهد ثلاثي الأبعاد نشطة",
    titleLead: "نحوّل رواية القصص",
    titleAccent: "إلى إيرادات",
    deck:
      "تسويق مُدمج مدعوم بالذكاء الاصطناعي يضع المنتجات داخل محتواك الحالي بإضاءة وتداخل وتتبّع دقيق — لتوسيع وصولك إلى اقتصاد عالمي.",
    ctaPrimary: "سجّل الآن",
    ctaSecondary: "معاينة توضيحية",
  },

  partners: { label: "يستخدمها بالفعل", accent: "الأفضل في المجال" },

  realityAugmented: {
    titleLead: "الواقع مقابل",
    titleAccent: "المعزّز",
    deck:
      "شاهد الذكاء الاصطناعي وهو يضع المنتجات على المساحات بتداخل وإضاءة دقيقين. من سطح مستوٍ إلى إدراج سلس للمنتج.",
  },

  opportunityFeed: {
    title: "تدفّق الفرص العالمي",
    deck: "فهرس مخزون لحظي. كل إطار مفحوص. وكل مساحة قابلة للتحقيق.",
  },

  backers: {
    title: "بدعم من روّاد الصناعة",
    names: ["Black Ambition", "May Davis Partners", "Elementa", "Mighty Capital"],
  },

  features: {
    titles: ["محرك الريمكس", "ذكاء اصطناعي سياقي", "بلا إعادة تصوير", "وصول واعٍ بالسياق"],
  },

  howItWorks: {
    titleLead: "طريق واضح",
    titleAccent: "إلى الأمام.",
    steps: [
      {
        title: "اربط.",
        description:
          "تكامل سلس مع يوتيوب وإنستغرام وفيسبوك وتيك توك. نفهرس مكتبتك في دقائق، لا في أسابيع.",
      },
      {
        title: "طابِق.",
        description: "يحدّد الذكاء الاصطناعي لدينا الفرص الآمنة للعلامات التي تناسب أسلوبك تحديدًا.",
      },
      {
        title: "اربح.",
        description: "وافق على عمليات الإدراج، وحقّق إيرادًا متكررًا من أرشيف محتواك.",
      },
    ],
  },

  testimonial: {
    quote:
      "«ساعدنا FullScale على استخراج قيمة من محتوى كنا قد نسيناه. الأمر أشبه باكتشاف مصدر دخل جديد بالكامل دون أن نغيّر طريقة صناعتنا للمحتوى.»",
    attribution: "— أحد صنّاع المحتوى الأوائل",
  },

  cohort: {
    titleLead: "انضم إلى",
    titleAccent: "المجموعة التأسيسية.",
    deck:
      "لست مستعدًا لأتمتة كل شيء؟ انضم إلى مجموعتنا الخاصة من صناع المحتوى الشركاء الذين يصوغون مستقبل المنصة.",
  },

  betaModal: {
    restricted: "الوصول مقيّد",
    notInCohort: "لست ضمن المجموعة التأسيسية بعد.",
    titleLead: "FullScale حاليًا",
    titleAccent: "بالدعوة فقط.",
    deck:
      "نستقبل مجموعة مختارة من صناع المحتوى المؤسسين لضمان أفضل تجربة ممكنة. تُراجَع الطلبات يوميًا.",
    ctaPrimary: "سجّل الآن",
    alreadyPartner: "شريك بالفعل؟ سجّل الدخول",
  },
};
