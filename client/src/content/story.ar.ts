import type { StoryContent } from "./types";

/**
 * قصة FullScale — Arabic.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * STATUS: MACHINE-DRAFTED MODERN STANDARD ARABIC. NOT REVIEWED.
 *
 * This is a first pass so the Arabic page can be built, laid out and tested
 * with real text of a realistic length — Arabic runs shorter than English by
 * roughly 20–25% in character count and taller in line height, and a layout
 * proven against lorem or against English is not proven at all.
 *
 * It is NOT ready to face an audience. It needs a native copywriter, and the
 * point of this file being a module rather than a catalog is that they are
 * not confined to translating sentence for sentence. They may:
 *   · rewrite a paragraph that does not carry in Arabic,
 *   · cut one, or add one — `body` is an array,
 *   · reorder the sections,
 *   · change an argument that only works in an American market.
 * The page renders whatever this object contains.
 *
 * GLOSSARY DECISIONS TAKEN HERE, all open to being overruled:
 *   product placement  موضعة المنتج       (rather than a transliteration)
 *   creator            صانع المحتوى
 *   brand              العلامة التجارية
 *   surface            مساحة العرض           (the in-frame spot a product sits on)
 *   placement          إدراج
 *   marketplace        السوق
 *   FullScale          left in Latin, deliberately — see docs/PLAN_ARABIC.md §7
 * These six words appear across the whole product. Settle them once, here,
 * before anyone translates a second page.
 * ─────────────────────────────────────────────────────────────────────────
 */
export const storyAr: StoryContent = {
  nav: { backHome: "العودة إلى الصفحة الرئيسية" },

  masthead: {
    eyebrow: "قصة FullScale",
    title: "كيف نبني FullScale",
    deck:
      "كتبها وصوّرها الشخصان اللذان يبنيانها — الفكرة، والأجزاء الصريحة، والمقاطع التي نقولها فيها بصوتنا. وستجد هنا أيضًا تجارب صناع المحتوى والعلامات التجارية، حالما تتوفر عمليات إدراج تستحق العرض.",
  },

  thesis: "موضعة المنتج موجود منذ قرن. ولم يُعرض على صناع المحتوى تقريبًا في أي يوم.",

  byline: { label: "بقلم", linkedin: "لينكدإن" },

  inOurOwnVoice: "بصوتنا",

  sections: [
    {
      rail: "الفجوة",
      heading: "كل ما يستطيع معظم صناع المحتوى بيعه هو مقاطعة",
      body: [
        "القراءة الإعلانية في ستين ثانية هي الرعاية الافتراضية، لأنها الأسهل شراءً والأسهل تحققًا. وهي تنجح فعلًا. لكنها تطلب من صانع المحتوى أن يتوقف عن صنع الفيديو كي يدفع ثمن صنعه.",
        "أما الصيغة التي أرادتها العلامات التجارية منذ مئة عام — منتج موجود داخل اللقطة، في غرفة يعيش فيها أحدهم بالفعل — فقد ظلت حكرًا على إنتاجات لديها قسم إكسسوارات ووكالة متعاقدة.",
      ],
      takeaway: "الفجوة لم تكن يومًا في الطلب. لم تكن هناك ببساطة طريقة لإتمام الصفقة.",
    },
    {
      rail: "المساحات",
      heading: "نبحث عن المساحات الموجودة أصلًا داخل الكادر",
      body: [
        "يقرأ FullScale الفيديو ويجد الأماكن التي يمكن لمنتج أن يستقر فيها بشكل مقنع: مكتب، طاولة، رف، جدار خلف رأس أحدهم. هذه الأماكن موجودة أصلًا في لقطات منشورة أصلًا.",
        "وصانع المحتوى هو من يقرر أيها معروض للبيع. العلامة التجارية التي تتصفح السوق لا ترى إلا المساحات التي فتحها صانع المحتوى، وتسعّر الإدراج بحسب الانتشار الحقيقي لذلك الفيديو، ثم ترسل طلبًا.",
      ],
      takeaway: "لا تستطيع أي علامة تجارية أن ترى مساحة لم يوافق عليها صانع المحتوى.",
    },
    {
      rail: "الموافقة",
      heading: "صانع المحتوى يقول نعم ثلاث مرات",
      body: [
        "مرة حين يفتح مساحة للسوق. ومرة حين تطلبها علامة تجارية بعينها فيقبل أو يرفض من صندوق الطلبات. ومرة حين تكون النسخة النهائية أمامه فيقرر إن كانت ستُنشر أصلًا.",
        "لا تحدث أي من هذه الخطوات بمؤقّت، ولا يُنشر شيء من تلقاء نفسه.",
      ],
      takeaway: "نفضّل أن نخسر عملية إدراج على أن نفاجئ بها صانع المحتوى.",
    },
    {
      rail: "اللقطات",
      heading: "لا نحتفظ بالفيديو الخاص بك",
      body: [
        "لإيجاد المساحات ننزّل الفيديو، ونأخذ الإطارات التي نحتاجها، ونسجّل مواضع المساحات، ثم نحذف المصدر. وحين تلتزم علامة تجارية ننزّله مرة أخرى بدقته الكاملة للمعالجة، ثم نحذفه مجددًا.",
        "ما نحتفظ به هو الصور المصغّرة والإحداثيات والنتائج — الأجزاء التي تجعل السوق يعمل. أما المكتبة فتبقى لك، على قناتك، تحت حسابك.",
      ],
      takeaway: "لقطاتك ليست مخزوننا.",
    },
  ],

  band: {
    eyebrow: "كيف وصلنا إلى هنا",
    title: "الجزء الذي لا يتعلق بالمنتج",
    deck:
      "جمع التمويل لبناء هذا كان قصة بحد ذاته، ولم يسر كما تسير الرواية المرتّبة. كلا المقطعين لنا، وقد صُوّرا حينها.",
  },

  grid: { eyebrow: "دراسات حالة", title: "عمليات إدراج نُفّذت" },

  find: { title: "تجدنا هنا", instagram: "إنستغرام", youtube: "يوتيوب" },

  player: { close: "إغلاق" },
};
