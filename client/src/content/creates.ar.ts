import type { CreatesContent } from "./types";

/**
 * /creates — Arabic.
 *
 * STATUS: MACHINE-DRAFTED MSA. NOT REVIEWED. See docs/GLOSSARY_ARABIC.md.
 *
 * NOTE FOR THE COPYWRITER: `showcase.descriptions` is a parallel list zipped
 * by index to nine REAL campaigns whose titles stay in Latin — Deleon, ANTA x
 * Kyrie, Chase United, Nike Blueprint, MGK x Doritos, ROKU, Smirnoff x BET,
 * Home Depot, LEGO. Keep the list nine long and in the same order, or a
 * description will end up under the wrong piece of work. The brand names
 * inside each description stay Latin too.
 */
export const createsAr: CreatesContent = {
  badge: "FullScale Creates",

  hero: {
    title: "محتوى يُحدث صلة حقيقية",
    deck:
      "نصنع وننتقي المحتوى لجمهور يطلب شيئًا حقيقيًا. الذكاء الاصطناعي يسرّع الحرفة — لكن صانع المحتوى هو من يقود القصة. وفي تلك الشراكة يكمن الأثر.",
    ctaPrimary: "اعمل معنا",
    ctaSecondary: "شاهد أعمالنا",
  },

  capabilities: {
    title: "ما الذي نقدّمه",
    deck: "إنتاج محتوى متكامل لصناع المحتوى والعلامات التجارية التي تقدّر الأصالة",
    items: [
      {
        title: "إنتاج المحتوى",
        description: "من الفكرة إلى النسخة النهائية — إنتاج فيديو متكامل لصناع المحتوى الرقمي",
      },
      {
        title: "شراكات صناع المحتوى",
        description: "شراكات استراتيجية تربط العلامات التجارية بأصوات حقيقية من صناع المحتوى",
      },
      {
        title: "سير عمل معزّز بالذكاء الاصطناعي",
        description: "نوظّف أدوات الذكاء الاصطناعي لتسريع الإنتاج مع الحفاظ على اللمسة الإنسانية",
      },
      {
        title: "التوزيع والوصول",
        description: "استراتيجية محتوى متعددة المنصات لتعظيم تفاعل الجمهور وأثره",
      },
    ],
  },

  showcase: {
    title: "أعمالنا",
    deck: "مجموعة من الأعمال صُنعت عند تقاطع الإبداع والتقنية",
    descriptions: [
      "مقطع ترويجي لشراكة ANTA مع Kyrie Irving",
      "سلسلة محتوى برعاية Chase United",
      "محتوى حملة لفيلم Soul من Disney وPixar",
      "محتوى برعاية LEGO",
      "تفعيل برعاية مع MGK في حفل جوائز VMAs",
      "التعريف بمساحة Chelsea Factory للفنون الأدائية",
      "فيلم ملخّص من حفل VMAs مع Lil Yachty",
      "سلسلة مسابقة لعروض المشاريع بتحكيم Dr. Marcus Collins وRoy Broderick, Jr.",
      "فيلم للعلامة التجارية CeraVe",
      "محتوى حملة لمبادرة Blueprint من Nike",
      "مبادرة Retool Your School من The Home Depot",
      "أفضل خمسة متأهلين لصندوق Real Change Opportunity من Mountain Dew",
    ],
  },

  philosophy: {
    title: "فلسفة FullScale Creates",
    body:
      "نؤمن بقوة القصص الحقيقية التي يرويها أشخاص حقيقيون. حين يملك صناع المحتوى السرد وتعمل الأدوات في خدمة رؤيتهم، لا يكتفي المحتوى بتحقيق النتائج — بل يُحدث صلة.",
  },

  cta: {
    title: "مستعد لصنع شيء حقيقي؟",
    deck:
      "سواء كنت صانع محتوى تسعى لإنتاج محتوى متميز، أو علامة تجارية تبحث عن شراكات حقيقية.",
    ctaPrimary: "تواصل معنا",
    ctaSecondary: "استكشف السوق",
  },
};
