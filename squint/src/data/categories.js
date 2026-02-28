/**
 * Category data for Squint.
 * 13 categories across 3 types: Famous People, Landmarks, and Scenes/Objects.
 *
 * IMAGE SETUP — Two approaches:
 *
 * A) PUBLIC FIGURES (real photos you license or source):
 *    1. Drop photos into: assets/images/<category>/<name>.jpg
 *    2. Update the entry: image: require('../../assets/images/hip-hop/drake.jpg')
 *
 * B) AI-GENERATED (images you OWN, no licensing needed):
 *    1. Run: REPLICATE_API_TOKEN="..." python3 scripts/generate-flux-images.py
 *    2. Images saved to: assets/images/<category>/
 *    3. Update the entry: image: require('../../assets/images/landmarks/eiffel-tower.png')
 *
 * OPTIONS: Each option is a mini description / clue — NOT the direct name.
 * The first option always corresponds to the correct answer (the `name` field).
 */

const categories = [
  // ─────────────────────────────────────────────
  // 1. HIP HOP LEGENDS
  // ─────────────────────────────────────────────
  {
    id: 'hip-hop',
    name: 'Hip Hop Legends',
    icon: '🎤',
    color: '#FF4444',
    faces: [
      {
        id: 'hh-1',
        name: 'Drake',
        image: null,
        imageColor: '#8B6914',
        initials: 'D',
        options: [
          'Toronto rapper who started from the bottom on Degrassi',
          'Compton lyricist crowned king of West Coast rap',
          'Dreamville founder who went platinum with no features',
          'Atlanta trap pioneer known for Auto-Tune melodies',
        ],
      },
      {
        id: 'hh-2',
        name: 'Jay-Z',
        image: null,
        imageColor: '#1C1C1C',
        initials: 'JZ',
        options: [
          'Brooklyn mogul who built Roc-A-Fella into an empire',
          'Queensbridge poet who painted street life on Illmatic',
          'Bad Boy mogul who made hip hop and fashion collide',
          'Chicago visionary who dropped out to produce beats',
        ],
      },
      {
        id: 'hh-3',
        name: 'Kendrick Lamar',
        image: null,
        imageColor: '#4A0E0E',
        initials: 'KL',
        options: [
          'Compton storyteller who took rap to Pulitzer Prize heights',
          'Dreamville founder who went platinum with no features',
          'Toronto rapper who started from the bottom on Degrassi',
          'Odd Future leader who reinvents himself every album',
        ],
      },
      {
        id: 'hh-4',
        name: 'Nicki Minaj',
        image: null,
        imageColor: '#FF69B4',
        initials: 'NM',
        options: [
          'Queens rapper who crowned herself the Queen of Rap',
          'Bronx star who went from Love & Hip Hop to #1',
          'Houston hottie driving the hot girl summer movement',
          'Brooklyn queen bee who pioneered female rap fashion',
        ],
      },
      {
        id: 'hh-5',
        name: 'Kanye West',
        image: null,
        imageColor: '#8B4513',
        initials: 'KW',
        options: [
          'Chicago producer turned rapper who dropped out of college',
          'Brooklyn mogul who built Roc-A-Fella into an empire',
          'Cleveland dreamer who put mental health in hip hop',
          'Superproducer who created hits across every genre',
        ],
      },
      {
        id: 'hh-6',
        name: 'Lil Wayne',
        image: null,
        imageColor: '#B22222',
        initials: 'LW',
        options: [
          'New Orleans legend who dropped more mixtapes than anyone',
          'Cash Money co-founder who put the South on the map',
          'Atlanta\'s self-proclaimed King of the South',
          'Former college basketball player turned trap hitmaker',
        ],
      },
      {
        id: 'hh-7',
        name: 'Cardi B',
        image: null,
        imageColor: '#DC143C',
        initials: 'CB',
        options: [
          'Bronx sensation who went from reality TV to Grammy winner',
          'Queens rapper who crowned herself the Queen of Rap',
          'Houston hottie driving the hot girl summer movement',
          'Genre-blending hitmaker who went viral on the internet',
        ],
      },
      {
        id: 'hh-8',
        name: 'Travis Scott',
        image: null,
        imageColor: '#4B3621',
        initials: 'TS',
        options: [
          'Houston rapper known for raging concerts and Astroworld',
          'Cleveland dreamer who put mental health in hip hop',
          'Cactus Jack signee with smooth melodic vibes',
          'Atlanta mumble rap pioneer with a cult following',
        ],
      },
      {
        id: 'hh-9',
        name: 'Snoop Dogg',
        image: null,
        imageColor: '#228B22',
        initials: 'SD',
        options: [
          'Long Beach legend who debuted on The Chronic in \'92',
          'Compton producer who built Aftermath and Beats by Dre',
          'N.W.A. member turned Hollywood movie star',
          'West Coast G-funk pioneer who regulated the game',
        ],
      },
      {
        id: 'hh-10',
        name: 'Megan Thee Stallion',
        image: null,
        imageColor: '#FF6347',
        initials: 'MS',
        options: [
          'Houston hottie with a degree who drives hot girl summer',
          'Bronx star who went from reality TV to the Grammys',
          'Genre-blending viral sensation from Los Angeles',
          'Memphis rapper who brought the energy with F.N.F.',
        ],
      },
    ],
  },

  // ─────────────────────────────────────────────
  // 2. POP STARS
  // ─────────────────────────────────────────────
  {
    id: 'pop-stars',
    name: 'Pop Stars',
    icon: '🌟',
    color: '#FF69B4',
    faces: [
      {
        id: 'ps-1',
        name: 'Taylor Swift',
        image: null,
        imageColor: '#FF69B4',
        initials: 'TS',
        options: [
          'Country girl turned pop queen with a catalog of eras',
          'Powerhouse vocalist with the signature high ponytail',
          'Disney Channel alum turned pop star and beauty mogul',
          'Pop star who kissed a girl and shot fireworks on stage',
        ],
      },
      {
        id: 'ps-2',
        name: 'Ariana Grande',
        image: null,
        imageColor: '#DDA0DD',
        initials: 'AG',
        options: [
          'Nickelodeon alum with a ponytail and five-octave range',
          'Country girl turned global pop queen known for her eras',
          'British-Albanian pop star who set new rules for dance',
          'Former girl group member who came straight from Havana',
        ],
      },
      {
        id: 'ps-3',
        name: 'Billie Eilish',
        image: null,
        imageColor: '#32CD32',
        initials: 'BE',
        options: [
          'Whisper-voiced teen who broke records from her bedroom',
          'Disney star who channeled heartbreak into a debut smash',
          'Alt-pop artist who blurs genres and boundaries',
          'New Zealand teen who called out the royals at 16',
        ],
      },
      {
        id: 'ps-4',
        name: 'Ed Sheeran',
        image: null,
        imageColor: '#FF8C00',
        initials: 'ES',
        options: [
          'Red-haired British singer with just a guitar and loop pedal',
          'Grammy-winning British vocalist with a soulful ballad voice',
          'Scottish singer known for emotional heartbreak ballads',
          'Canadian heartthrob who started posting covers on Vine',
        ],
      },
      {
        id: 'ps-5',
        name: 'Justin Bieber',
        image: null,
        imageColor: '#9370DB',
        initials: 'JB',
        options: [
          'Canadian kid discovered on YouTube who became a global idol',
          'Canadian heartthrob who started posting covers on Vine',
          'Producer-singer who writes pop hits with perfect pitch',
          'British boy band star who went solo with bold fashion',
        ],
      },
      {
        id: 'ps-6',
        name: 'Lady Gaga',
        image: null,
        imageColor: '#C71585',
        initials: 'LG',
        options: [
          'Avant-garde pop icon who once arrived in a meat dress',
          'Queen of Pop who ruled the \'80s and constantly reinvented',
          'Pop star who kissed a girl and shot fireworks on stage',
          'Acrobatic pop-rock performer who sings from the rafters',
        ],
      },
      {
        id: 'ps-7',
        name: 'Harry Styles',
        image: null,
        imageColor: '#4169E1',
        initials: 'HS',
        options: [
          'Boy band heartthrob who went solo with bold fashion flair',
          'Irish singer from the same boy band gone country-pop',
          'Boy band dropout who went dark and moody as a solo act',
          'Boy band member who stayed closest to pop-rock roots',
        ],
      },
      {
        id: 'ps-8',
        name: 'Dua Lipa',
        image: null,
        imageColor: '#FF1493',
        initials: 'DL',
        options: [
          'British-Albanian singer who set new rules for dance pop',
          'Nickelodeon alum with a ponytail and five-octave range',
          'Whisper-voiced artist who broke records from her bedroom',
          'Genre-blending viral sensation from Los Angeles',
        ],
      },
      {
        id: 'ps-9',
        name: 'The Weeknd',
        image: null,
        imageColor: '#8B0000',
        initials: 'TW',
        options: [
          'Toronto singer who emerged from mystery with dark R&B',
          'Hawaiian-born showman who does pop, funk, and R&B',
          'Genre-bending artist covered head to toe in face tattoos',
          'Smooth-voiced singer who debuted as a teen from El Paso',
        ],
      },
      {
        id: 'ps-10',
        name: 'Olivia Rodrigo',
        image: null,
        imageColor: '#8A2BE2',
        initials: 'OR',
        options: [
          'Disney star whose heartbreak debut album dominated 2021',
          'Whisper-voiced artist who broke records from her bedroom',
          'Disney alum with clever pop songs and killer stage presence',
          'Singer discovered on YouTube who built an indie pop career',
        ],
      },
    ],
  },

  // ─────────────────────────────────────────────
  // 3. ICONIC WOMEN OF AMERICA
  // ─────────────────────────────────────────────
  {
    id: 'iconic-women',
    name: 'Iconic Women of America',
    icon: '👑',
    color: '#FFD700',
    faces: [
      {
        id: 'iw-1',
        name: 'Oprah Winfrey',
        image: null,
        imageColor: '#FF8C00',
        initials: 'OW',
        options: [
          'Media mogul who built an empire from a talk show chair',
          'EGOT-winning comedian who co-hosts The View every morning',
          'Morning news anchor and best friend to a media mogul',
          'Daytime TV host who danced her way into living rooms',
        ],
      },
      {
        id: 'iw-2',
        name: 'Michelle Obama',
        image: null,
        imageColor: '#4682B4',
        initials: 'MO',
        options: [
          'Former First Lady who championed health and education',
          'First woman to serve as Vice President of the U.S.',
          'Stanford professor who became Secretary of State',
          'Educator who kept teaching while living in the White House',
        ],
      },
      {
        id: 'iw-3',
        name: 'Serena Williams',
        image: null,
        imageColor: '#6A0DAD',
        initials: 'SW',
        options: [
          'Tennis champion with 23 Grand Slam singles titles',
          'Tennis pioneer who paved the way alongside her sister',
          'Four-time Grand Slam champion who spoke up for mental health',
          'Most decorated gymnast in World Championship history',
        ],
      },
      {
        id: 'iw-4',
        name: 'Beyoncé',
        image: null,
        imageColor: '#C8A415',
        initials: 'B',
        options: [
          'Houston queen who went from Destiny\'s Child to global icon',
          'Barbadian superstar who built a beauty and fashion empire',
          'Classically trained pianist who lit the music world on fire',
          'Queen of Hip-Hop Soul from Yonkers, New York',
        ],
      },
      {
        id: 'iw-5',
        name: 'Kamala Harris',
        image: null,
        imageColor: '#191970',
        initials: 'KH',
        options: [
          'First woman and person of color to serve as Vice President',
          'Former First Lady who championed healthy eating for kids',
          'Former Secretary of State who ran for the top office',
          'First woman to serve as Speaker of the House',
        ],
      },
      {
        id: 'iw-6',
        name: 'Viola Davis',
        image: null,
        imageColor: '#800020',
        initials: 'VD',
        options: [
          'EGOT-winning actress who made history at the Emmys',
          'Actress who played a fierce music mogul on primetime TV',
          'Kenyan-Mexican actress who won an Oscar on her very first try',
          'Actress who brought Tina Turner\'s story to the big screen',
        ],
      },
      {
        id: 'iw-7',
        name: 'Simone Biles',
        image: null,
        imageColor: '#FF4500',
        initials: 'SB',
        options: [
          'Most decorated gymnast who redefined what\'s possible',
          'First African American to win all-around Olympic gold',
          'Two-time Olympic captain of the U.S. gymnastics team',
          'Hmong American gymnast who won all-around gold in Tokyo',
        ],
      },
      {
        id: 'iw-8',
        name: 'Dolly Parton',
        image: null,
        imageColor: '#FFB6C1',
        initials: 'DP',
        options: [
          'Country music legend who always works 9 to 5 with heart',
          'Coal miner\'s daughter who became a country music queen',
          'Red-haired country icon who also conquered TV and Broadway',
          'American Idol winner who became country\'s biggest voice',
        ],
      },
      {
        id: 'iw-9',
        name: 'Ruth Bader Ginsburg',
        image: null,
        imageColor: '#2F4F4F',
        initials: 'RBG',
        options: [
          'Supreme Court justice who became a pop culture icon for equality',
          'First Latina to serve on the nation\'s highest court',
          'First woman ever appointed to the Supreme Court',
          'Former Harvard Law dean who joined the highest court',
        ],
      },
      {
        id: 'iw-10',
        name: 'Maya Angelou',
        image: null,
        imageColor: '#8B4513',
        initials: 'MA',
        options: [
          'Poet and author who knew why the caged bird sings',
          'Nobel Prize-winning novelist who explored the Black experience',
          'Pulitzer Prize-winning author of The Color Purple',
          'Harlem Renaissance writer who captured Southern Black life',
        ],
      },
    ],
  },

  // ─────────────────────────────────────────────
  // 4. NBA LEGENDS
  // ─────────────────────────────────────────────
  {
    id: 'nba-legends',
    name: 'NBA Legends',
    icon: '🏀',
    color: '#FF6B00',
    faces: [
      {
        id: 'nba-1',
        name: 'Michael Jordan',
        image: null,
        imageColor: '#B22222',
        initials: 'MJ',
        options: [
          '6x champion who flew through the air in Chicago wearing #23',
          'The King who chased greatness from Cleveland to LA',
          'Mamba Mentality icon who spent 20 years in purple and gold',
          'Showtime floor general who made LA basketball electric',
        ],
      },
      {
        id: 'nba-2',
        name: 'LeBron James',
        image: null,
        imageColor: '#4B0082',
        initials: 'LJ',
        options: [
          'The King who took his talents from Cleveland to Miami to LA',
          '6x champion who never lost a Finals series in Chicago',
          '7-foot scoring machine with a silky-smooth jumper',
          'The Greek Freak who went from unknown to MVP in Milwaukee',
        ],
      },
      {
        id: 'nba-3',
        name: 'Kobe Bryant',
        image: null,
        imageColor: '#FFD700',
        initials: 'KB',
        options: [
          'Mamba Mentality legend with 5 rings in purple and gold',
          '6x champion who was the greatest to ever lace them up',
          'Scoring machine who once dropped 13 points in 33 seconds',
          'Pound-for-pound warrior who crossed over everyone he faced',
        ],
      },
      {
        id: 'nba-4',
        name: 'Stephen Curry',
        image: null,
        imageColor: '#1E90FF',
        initials: 'SC',
        options: [
          'Baby-faced assassin who revolutionized the three-point shot',
          'Splash brother who once scored 37 points in a single quarter',
          'Point God who orchestrates every play to absolute perfection',
          'Triple-double machine with the most explosive athleticism',
        ],
      },
      {
        id: 'nba-5',
        name: 'Magic Johnson',
        image: null,
        imageColor: '#DAA520',
        initials: 'MJ',
        options: [
          'Showtime point guard who made LA basketball a spectacle',
          'Boston legend who traded trash talk and titles with LA',
          'All-time scoring king with the unstoppable skyhook',
          'Bad Boy Pistons leader with a killer smile and crossover',
        ],
      },
      {
        id: 'nba-6',
        name: 'Shaquille O\'Neal',
        image: null,
        imageColor: '#000080',
        initials: 'SO',
        options: [
          'Dominant big man who shattered backboards and made movies',
          'Nigerian-born center with the dreamiest footwork ever seen',
          'Georgetown giant who anchored the Knicks for a decade',
          'Superman center who dominated the slam dunk contest',
        ],
      },
      {
        id: 'nba-7',
        name: 'Kevin Durant',
        image: null,
        imageColor: '#FF4500',
        initials: 'KD',
        options: [
          '7-foot scoring machine who can shoot over anyone alive',
          'The King who chased greatness across three cities',
          'Silent superstar who lets his Finals MVPs do the talking',
          'Two-way wing nicknamed PG-13 for his playoff theatrics',
        ],
      },
      {
        id: 'nba-8',
        name: 'Allen Iverson',
        image: null,
        imageColor: '#8B0000',
        initials: 'AI',
        options: [
          'The Answer — pound-for-pound toughest player to ever step over',
          'Youngest MVP whose career was tragically cut short by injuries',
          'Canadian point guard who won back-to-back MVPs in Phoenix',
          'Pass-first floor general with a triple-double habit',
        ],
      },
      {
        id: 'nba-9',
        name: 'Tim Duncan',
        image: null,
        imageColor: '#2F2F2F',
        initials: 'TD',
        options: [
          'The Big Fundamental who quietly won 5 rings in San Antonio',
          'Intense power forward who finally brought a title to Boston',
          'German legend who brought Dallas its only championship ring',
          'The Mailman who always delivered in Utah but never got a ring',
        ],
      },
      {
        id: 'nba-10',
        name: 'Wilt Chamberlain',
        image: null,
        imageColor: '#4B0082',
        initials: 'WC',
        options: [
          'The only player to ever score 100 points in a single game',
          '11-time champion who defined winning above all else in Boston',
          'All-time scoring king with the unstoppable skyhook shot',
          'First player to average a triple-double for an entire season',
        ],
      },
    ],
  },

  // ─────────────────────────────────────────────
  // 5. HOLLYWOOD A-LIST
  // ─────────────────────────────────────────────
  {
    id: 'hollywood',
    name: 'Hollywood A-List',
    icon: '🎬',
    color: '#E5C100',
    faces: [
      {
        id: 'hw-1',
        name: 'Denzel Washington',
        image: null,
        imageColor: '#1C1C1C',
        initials: 'DW',
        options: [
          'Two-time Oscar winner who commands every scene he enters',
          'Fresh Prince who became one of Hollywood\'s biggest stars',
          'Highest-grossing actor of all time with unmistakable intensity',
          'Voice of God narrator who makes every film feel epic',
        ],
      },
      {
        id: 'hw-2',
        name: 'Leonardo DiCaprio',
        image: null,
        imageColor: '#2E8B57',
        initials: 'LD',
        options: [
          'Oscar winner who survived the Titanic and the Revenant',
          'Leading man from Fight Club to Once Upon a Time in Hollywood',
          'Good Will Hunting star who keeps getting stranded in movies',
          'Action star who does his own stunts at impossible heights',
        ],
      },
      {
        id: 'hw-3',
        name: 'Meryl Streep',
        image: null,
        imageColor: '#708090',
        initials: 'MS',
        options: [
          'Most Oscar-nominated actress in the history of cinema',
          'Australian actress who played an elven queen and a legend',
          'British dame who played M and won an Oscar in 8 minutes',
          'British queen of the screen who literally played The Queen',
        ],
      },
      {
        id: 'hw-4',
        name: 'Will Smith',
        image: null,
        imageColor: '#4169E1',
        initials: 'WS',
        options: [
          'Fresh Prince who went from Philly rap to Hollywood royalty',
          'Two-time Oscar winner known for intense dramatic performances',
          'Comedian who made Bad Boys a blockbuster franchise',
          'Comedian turned Oscar winner who channeled Ray Charles',
        ],
      },
      {
        id: 'hw-5',
        name: 'Scarlett Johansson',
        image: null,
        imageColor: '#DC143C',
        initials: 'SJ',
        options: [
          'Highest-grossing actress who suited up as a Black Widow',
          'Hunger Games star who tripped her way to an Oscar',
          'Australian actress who brought Barbie to life on the big screen',
          'La La Land dancer who won the Oscar for best actress',
        ],
      },
      {
        id: 'hw-6',
        name: 'Samuel L. Jackson',
        image: null,
        imageColor: '#6A0DAD',
        initials: 'SJ',
        options: [
          'Highest-grossing actor ever who carries a very special wallet',
          'Voice of God narrator who brings gravitas to every role',
          'Actor who offered the red pill in a sci-fi classic',
          'British actor constantly tipped to be the next James Bond',
        ],
      },
      {
        id: 'hw-7',
        name: 'Jennifer Aniston',
        image: null,
        imageColor: '#F4A460',
        initials: 'JA',
        options: [
          'America\'s sweetheart from the most iconic sitcom apartment',
          'Her sitcom bestie who was famously obsessed with cleanliness',
          'Legally Blonde star turned Hollywood production powerhouse',
          'Pretty Woman star with the most famous smile in Hollywood',
        ],
      },
      {
        id: 'hw-8',
        name: 'Brad Pitt',
        image: null,
        imageColor: '#D2B48C',
        initials: 'BP',
        options: [
          'Leading man who fought in clubs and pulled off casino heists',
          'Oscar winner who survived the Titanic and the frozen wilderness',
          'ER doctor turned Ocean\'s ringleader and Hollywood activist',
          'Actor who needed rescuing from both Mars and Normandy Beach',
        ],
      },
      {
        id: 'hw-9',
        name: 'Zendaya',
        image: null,
        imageColor: '#FF4081',
        initials: 'Z',
        options: [
          'Disney star who swung into the MCU and HBO teen drama',
          'Singer-actress who became Disney\'s live-action mermaid',
          'Young actress who debuted as Rue in the Hunger Games',
          'Grown-ish star and activist from a beloved TV family',
        ],
      },
      {
        id: 'hw-10',
        name: 'Morgan Freeman',
        image: null,
        imageColor: '#3E2723',
        initials: 'MF',
        options: [
          'Voice of God narrator who narrated penguins and prison breaks',
          'Highest-grossing actor ever with unmistakable screen presence',
          'Two-time Oscar winner who commands every dramatic scene',
          'Iconic bass voice behind Darth Vader and the Lion King',
        ],
      },
    ],
  },

  // ─────────────────────────────────────────────
  // 6. R&B ICONS
  // ─────────────────────────────────────────────
  {
    id: 'rnb-icons',
    name: 'R&B Icons',
    icon: '🎵',
    color: '#9C27B0',
    faces: [
      {
        id: 'rb-1',
        name: 'Rihanna',
        image: null,
        imageColor: '#DC143C',
        initials: 'R',
        options: [
          'Barbadian queen who built Fenty and stands under her umbrella',
          'Houston queen who runs the world from Destiny\'s stage',
          'TDE songstress who bared her soul on Ctrl and S.O.S.',
          'Ethereal vocalist known for chill, dreamy R&B melodies',
        ],
      },
      {
        id: 'rb-2',
        name: 'Usher',
        image: null,
        imageColor: '#4A4A4A',
        initials: 'U',
        options: [
          'Atlanta showman who taught the world his confessions',
          'Dancer-singer who\'s been making hits since he was a teen',
          'Smooth singer-songwriter always seen in a signature fedora',
          'Virginia heartthrob known for slow jams and pure charisma',
        ],
      },
      {
        id: 'rb-3',
        name: 'Alicia Keys',
        image: null,
        imageColor: '#B8860B',
        initials: 'AK',
        options: [
          'Classically trained pianist who set the music world on fire',
          'Former Destiny\'s Child frontwoman turned global queen',
          'Queen of Hip-Hop Soul from Yonkers, New York',
          'Fugees star who dropped one perfect solo album and vanished',
        ],
      },
      {
        id: 'rb-4',
        name: 'Frank Ocean',
        image: null,
        imageColor: '#FF8C00',
        initials: 'FO',
        options: [
          'Reclusive artist who rewrote R&B with Channel Orange and Blonde',
          'Toronto singer who emerged from the shadows with dark R&B',
          'Toronto singer blending gospel roots with modern R&B',
          'Genre-bending artist who told everyone to just adorn themselves',
        ],
      },
      {
        id: 'rb-5',
        name: 'SZA',
        image: null,
        imageColor: '#8FBC8F',
        initials: 'S',
        options: [
          'TDE songstress who bared her soul on Ctrl and S.O.S.',
          'Ethereal vocalist with dreamy, meditative R&B vibes',
          'Introverted Atlanta singer with raw emotional ballads',
          'Mystery artist who hid behind sunglasses and let music speak',
        ],
      },
      {
        id: 'rb-6',
        name: 'Mariah Carey',
        image: null,
        imageColor: '#FFB6C1',
        initials: 'MC',
        options: [
          'Five-octave diva who literally owns Christmas with one song',
          'The Voice — greatest female vocalist of her generation',
          'Canadian powerhouse whose heart will go on and on forever',
          'Powerhouse vocalist who started as a genie in a bottle',
        ],
      },
      {
        id: 'rb-7',
        name: 'Chris Brown',
        image: null,
        imageColor: '#CD853F',
        initials: 'CB',
        options: [
          'Singer-dancer making Billboard hits since he was a teenager',
          'Atlanta showman who mentored the greats and owned the stage',
          'Virginia crooner known for ladies\' anthems and smooth moves',
          'Former B2K frontman with iconic choreography and dance moves',
        ],
      },
      {
        id: 'rb-8',
        name: 'Lauryn Hill',
        image: null,
        imageColor: '#556B2F',
        initials: 'LH',
        options: [
          'Fugees legend who dropped one perfect solo album and vanished',
          'Neo-soul queen from Dallas who stays On & On forever',
          'Acoustic soul artist who reminded us we are not our hair',
          'Philly poet who sings with raw emotion and literary grace',
        ],
      },
      {
        id: 'rb-9',
        name: 'Toni Braxton',
        image: null,
        imageColor: '#800080',
        initials: 'TB',
        options: [
          'Sultry-voiced star who un-broke our hearts in the \'90s',
          'Five-octave diva who owns the entire holiday music season',
          'Girl group who told the world not to go chasing waterfalls',
          'TV\'s Moesha who also became a Grammy-winning vocalist',
        ],
      },
      {
        id: 'rb-10',
        name: 'H.E.R.',
        image: null,
        imageColor: '#696969',
        initials: 'H',
        options: [
          'Mystery artist who hid behind sunglasses and let her guitar talk',
          'TDE songstress with raw vulnerability and a devoted fanbase',
          'Introverted Atlanta singer with emotional ballads and vibes',
          'Oakland R&B singer blending pop, soul, and raw real talk',
        ],
      },
    ],
  },

  // ─────────────────────────────────────────────
  // 7. WORLD LEADERS & CHANGEMAKERS
  // ─────────────────────────────────────────────
  {
    id: 'world-leaders',
    name: 'World Leaders',
    icon: '🌍',
    color: '#2196F3',
    faces: [
      {
        id: 'wl-1',
        name: 'Barack Obama',
        image: null,
        imageColor: '#1E3A5F',
        initials: 'BO',
        options: [
          '44th President who made history and said "Yes We Can"',
          'Two-time Oscar winner who commands every scene he enters',
          'Fresh Prince who went from Philly rap to Hollywood royalty',
          'Comedian turned Oscar winner who channeled Ray Charles',
        ],
      },
      {
        id: 'wl-2',
        name: 'Nelson Mandela',
        image: null,
        imageColor: '#228B22',
        initials: 'NM',
        options: [
          'South African leader who spent 27 years in prison for freedom',
          'South African archbishop who championed peace and forgiveness',
          'Ghanaian diplomat who led the United Nations as Secretary-General',
          'Voice of God narrator who brings gravitas to every role',
        ],
      },
      {
        id: 'wl-3',
        name: 'Martin Luther King Jr.',
        image: null,
        imageColor: '#2F4F4F',
        initials: 'MLK',
        options: [
          'Civil rights leader who had a dream and changed America',
          'Activist who said "by any means necessary" for Black liberation',
          'Civil rights icon who marched across the Edmund Pettus Bridge',
          'Abolitionist who escaped slavery and wrote his own narrative',
        ],
      },
      {
        id: 'wl-4',
        name: 'Queen Elizabeth II',
        image: null,
        imageColor: '#4169E1',
        initials: 'QE',
        options: [
          'Longest-reigning British monarch who served for 70 years',
          'People\'s Princess whose life was cut tragically short',
          'Britain\'s first female Prime Minister known as the Iron Lady',
          'Monarch who ruled during the height of the British Empire',
        ],
      },
      {
        id: 'wl-5',
        name: 'Abraham Lincoln',
        image: null,
        imageColor: '#1C1C1C',
        initials: 'AL',
        options: [
          'Top-hat president who preserved the Union and freed the enslaved',
          'First president and general who could not tell a lie',
          'Founding father who wrote the Declaration of Independence',
          'Rough Rider president who built the Panama Canal',
        ],
      },
      {
        id: 'wl-6',
        name: 'John F. Kennedy',
        image: null,
        imageColor: '#4682B4',
        initials: 'JFK',
        options: [
          'Young president who launched the Space Race from Camelot',
          'President who opened relations with China and resigned in scandal',
          'Actor-turned-president who told a wall to come down',
          'Charismatic president who played saxophone on late-night TV',
        ],
      },
      {
        id: 'wl-7',
        name: 'Mahatma Gandhi',
        image: null,
        imageColor: '#F5F5DC',
        initials: 'MG',
        options: [
          'Indian leader who freed a nation through nonviolent resistance',
          'India\'s first prime minister after independence from Britain',
          'Tibetan spiritual leader who advocates for peace in exile',
          'South African hero who spent 27 years imprisoned on an island',
        ],
      },
      {
        id: 'wl-8',
        name: 'Malala Yousafzai',
        image: null,
        imageColor: '#FF1493',
        initials: 'MY',
        options: [
          'Pakistani activist who survived being shot for defending education',
          'Swedish teen who sailed across the ocean to fight climate change',
          'British actress and UN Women goodwill ambassador',
          'Grown-ish star and activist from a beloved TV family dynasty',
        ],
      },
      {
        id: 'wl-9',
        name: 'Winston Churchill',
        image: null,
        imageColor: '#3B3B3B',
        initials: 'WC',
        options: [
          'British PM who rallied a nation with blood, toil, tears and sweat',
          'American president who led the Allies through most of WWII',
          'Supreme Allied Commander who became America\'s 34th president',
          'French general who led the resistance and rebuilt a republic',
        ],
      },
      {
        id: 'wl-10',
        name: 'Angela Merkel',
        image: null,
        imageColor: '#B0C4DE',
        initials: 'AM',
        options: [
          'German chancellor who led Europe for 16 years with quiet resolve',
          'British PM who navigated the turbulence of Brexit',
          'Former Secretary of State who ran for the highest office',
          'French economist who became head of the European Central Bank',
        ],
      },
    ],
  },

  // ─────────────────────────────────────────────
  // 8. TECH TITANS
  // ─────────────────────────────────────────────
  {
    id: 'tech-titans',
    name: 'Tech Titans',
    icon: '💻',
    color: '#00BCD4',
    faces: [
      {
        id: 'tt-1',
        name: 'Elon Musk',
        image: null,
        imageColor: '#2F4F4F',
        initials: 'EM',
        options: [
          'Rocket-launching CEO who also bought a social media platform',
          'Bald billionaire who built an everything-store empire online',
          'Harvard dropout who connected the world through a social network',
          'Philanthropist who built the world\'s biggest software company',
        ],
      },
      {
        id: 'tt-2',
        name: 'Jeff Bezos',
        image: null,
        imageColor: '#FF9900',
        initials: 'JB',
        options: [
          'Bald billionaire who built an everything-store from a garage',
          'Rocket-launching CEO who also bought a social media platform',
          'Co-founder of a search engine that became a verb',
          'Soft-spoken CEO running the world\'s most valuable tech company',
        ],
      },
      {
        id: 'tt-3',
        name: 'Bill Gates',
        image: null,
        imageColor: '#00A4EF',
        initials: 'BG',
        options: [
          'Philanthropist who put a PC on every desk and Windows on every screen',
          'Turtleneck visionary who built the most beloved tech brand ever',
          'Harvard dropout who connected the world through a social network',
          'His co-founder at Microsoft who later became a sports team owner',
        ],
      },
      {
        id: 'tt-4',
        name: 'Mark Zuckerberg',
        image: null,
        imageColor: '#4267B2',
        initials: 'MZ',
        options: [
          'Harvard dropout who connected 3 billion people on one platform',
          'CEO who built a short-form messaging platform with a blue bird',
          'Stanford kid who built a disappearing photo app worth billions',
          'Photo-sharing app creator who sold to a social media giant',
        ],
      },
      {
        id: 'tt-5',
        name: 'Steve Jobs',
        image: null,
        imageColor: '#555555',
        initials: 'SJ',
        options: [
          'Turtleneck visionary who put a thousand songs in your pocket',
          'Philanthropist who put Windows on every screen in the world',
          'Soft-spoken CEO who took over after the visionary passed away',
          'British designer who shaped every curve of the iPhone and iMac',
        ],
      },
      {
        id: 'tt-6',
        name: 'Tim Cook',
        image: null,
        imageColor: '#A3AAAE',
        initials: 'TC',
        options: [
          'Soft-spoken CEO who made the world\'s most valuable company even bigger',
          'Turtleneck visionary who put a thousand songs in your pocket',
          'Indian-born CEO running the world\'s biggest search company',
          'Indian-born CEO who transformed a software giant with cloud computing',
        ],
      },
      {
        id: 'tt-7',
        name: 'Sundar Pichai',
        image: null,
        imageColor: '#4285F4',
        initials: 'SP',
        options: [
          'Indian-born CEO running the company behind the world\'s top search engine',
          'Indian-born CEO who transformed a software giant with cloud computing',
          'Soft-spoken CEO who took Apple to even greater heights',
          'Co-founder of a search engine that became a household verb',
        ],
      },
      {
        id: 'tt-8',
        name: 'Jensen Huang',
        image: null,
        imageColor: '#76B900',
        initials: 'JH',
        options: [
          'Leather-jacket CEO whose GPU chips power the entire AI revolution',
          'CEO who turned a chip underdog into a competitor overnight',
          'Intel CEO who tried to catch up to the AI chip leaders',
          'Indian-born CEO who transformed Microsoft with cloud and AI',
        ],
      },
      {
        id: 'tt-9',
        name: 'Satya Nadella',
        image: null,
        imageColor: '#00A4EF',
        initials: 'SN',
        options: [
          'Indian-born CEO who revived Microsoft with cloud computing and AI',
          'Indian-born CEO running the world\'s biggest search company',
          'Soft-spoken CEO who took Apple to record-breaking valuations',
          'Former AWS exec who took over the everything-store empire',
        ],
      },
      {
        id: 'tt-10',
        name: 'Lisa Su',
        image: null,
        imageColor: '#ED1C24',
        initials: 'LS',
        options: [
          'CEO who turned a struggling chip company into a powerhouse',
          'Leather-jacket CEO whose GPU chips power the AI revolution',
          'Facebook COO who told women to lean in at work',
          'YouTube CEO who shaped how the world watches video online',
        ],
      },
    ],
  },

  // ─────────────────────────────────────────────
  // 9. SPORTS GOATS
  // ─────────────────────────────────────────────
  {
    id: 'sports-goats',
    name: 'Sports GOATs',
    icon: '🏆',
    color: '#4CAF50',
    faces: [
      {
        id: 'sg-1',
        name: 'Tom Brady',
        image: null,
        imageColor: '#002244',
        initials: 'TB',
        options: [
          '7-ring quarterback who won more Super Bowls than any franchise',
          'Sheriff of the NFL who set every passing record in Indianapolis',
          'Green Bay gunslinger with the most MVP awards among QBs',
          'Young Chiefs QB with a cannon arm and a famous girlfriend',
        ],
      },
      {
        id: 'sg-2',
        name: 'Usain Bolt',
        image: null,
        imageColor: '#FFD700',
        initials: 'UB',
        options: [
          'Jamaican lightning bolt — fastest human to ever live',
          'American sprinter who dominated the \'80s and \'90s Olympics',
          'American sprinter who was once the second-fastest man alive',
          'American sprinter who pushed the fastest man in every race',
        ],
      },
      {
        id: 'sg-3',
        name: 'Lionel Messi',
        image: null,
        imageColor: '#75AADB',
        initials: 'LM',
        options: [
          'Argentine wizard who finally lifted the World Cup in Qatar',
          'Portuguese goal machine with the most Champions League goals',
          'Brazilian flair player who dazzled but never won the big one',
          'French teen who became the youngest World Cup star since Pelé',
        ],
      },
      {
        id: 'sg-4',
        name: 'Muhammad Ali',
        image: null,
        imageColor: '#8B0000',
        initials: 'MA',
        options: [
          'The Greatest — floated like a butterfly, stung like a bee',
          'Iron fist heavyweight who was the baddest man on the planet',
          'Undefeated boxer who never lost in 50 professional fights',
          'Smokin\' heavyweight who battled The Greatest in a trilogy',
        ],
      },
      {
        id: 'sg-5',
        name: 'Tiger Woods',
        image: null,
        imageColor: '#006400',
        initials: 'TW',
        options: [
          'Golf legend who won 15 majors and made Sunday red iconic',
          'The Golden Bear with the most major championship wins ever',
          'Lefty golfer famous for his short game and epic rivalries',
          'Golf legend known as The King who made the sport popular',
        ],
      },
      {
        id: 'sg-6',
        name: 'Cristiano Ronaldo',
        image: null,
        imageColor: '#006633',
        initials: 'CR',
        options: [
          'Portuguese goal machine who celebrates with a signature jump',
          'Argentine wizard who dribbles through defenses like no one else',
          'Brazilian flair player who dazzled with tricks and skill',
          'Swedish striker who scored impossible bicycle kicks for fun',
        ],
      },
      {
        id: 'sg-7',
        name: 'Wayne Gretzky',
        image: null,
        imageColor: '#041E42',
        initials: 'WG',
        options: [
          'The Great One — hockey\'s all-time points leader by a mile',
          'Magnificent hockey center who rivaled The Great One in skill',
          'Canadian hockey phenom who is the best player of his era',
          'Legendary defenseman who changed how hockey is played',
        ],
      },
      {
        id: 'sg-8',
        name: 'Michael Phelps',
        image: null,
        imageColor: '#1E90FF',
        initials: 'MP',
        options: [
          'Most decorated Olympian ever with 23 gold medals in the pool',
          'American swimmer who was always chasing the golden champion',
          'Swimmer with 7 golds in 1972 before a greater champion arrived',
          'Australian swimmer known as Thorpedo who dominated freestyle',
        ],
      },
      {
        id: 'sg-9',
        name: 'Patrick Mahomes',
        image: null,
        imageColor: '#E31837',
        initials: 'PM',
        options: [
          'Young Chiefs QB with a cannon arm and back-to-back rings',
          'Bills QB with a rocket arm chasing his first championship',
          '7-ring GOAT quarterback who dominated for two decades',
          'Dynamic Ravens QB who runs and throws like no one else',
        ],
      },
      {
        id: 'sg-10',
        name: 'Sha\'Carri Richardson',
        image: null,
        imageColor: '#FF6347',
        initials: 'SR',
        options: [
          'Fastest woman in America who runs with long nails and flair',
          'Flo-Jo — fastest woman ever with those iconic one-legged suits',
          'Jamaican sprint queen who dominated the 100m for a decade',
          'Most decorated female track athlete in Olympic history',
        ],
      },
    ],
  },

  // ─────────────────────────────────────────────
  // 10. TV & STREAMING STARS
  // ─────────────────────────────────────────────
  {
    id: 'tv-streaming',
    name: 'TV & Streaming Stars',
    icon: '📺',
    color: '#E91E63',
    faces: [
      {
        id: 'tv-1',
        name: 'Pedro Pascal',
        image: null,
        imageColor: '#8B4513',
        initials: 'PP',
        options: [
          'Mandalorian dad who never takes off his helmet on screen',
          'Guatemalan-American actor who played a Marvel moon knight',
          'Mexican actor who played a rebel spy in a galaxy far away',
          'Spanish actor known for intense roles and a chilling villain',
        ],
      },
      {
        id: 'tv-2',
        name: 'Issa Rae',
        image: null,
        imageColor: '#FF7F50',
        initials: 'IR',
        options: [
          'Creator-star of an HBO show about being awkward and Black in LA',
          'Daughter of a music legend who stars in a family sitcom',
          'Her best friend and co-star on that same HBO comedy series',
          'Youngest Black executive producer in Hollywood history',
        ],
      },
      {
        id: 'tv-3',
        name: 'Millie Bobby Brown',
        image: null,
        imageColor: '#FF1493',
        initials: 'MB',
        options: [
          'British teen who shaved her head to fight monsters in Hawkins',
          'Redhead who faced Vecna alongside Eleven in the Upside Down',
          'Latina actress who became Netflix\'s most famous Wednesday',
          'British actress who joined the MCU as a fierce warrior',
        ],
      },
      {
        id: 'tv-4',
        name: 'Sterling K. Brown',
        image: null,
        imageColor: '#2F4F4F',
        initials: 'SB',
        options: [
          'Emmy winner who made America cry every week on This Is Us',
          'Two-time Oscar winner with a gentle intensity and quiet power',
          'Actor known for comedic roles and a thunderous screen presence',
          'Marvel villain who was supposed to be the next big thing',
        ],
      },
      {
        id: 'tv-5',
        name: 'Kerry Washington',
        image: null,
        imageColor: '#9932CC',
        initials: 'KW',
        options: [
          'Scandal fixer who handled Washington\'s biggest crises on ABC',
          'EGOT-winning actress who shattered Emmy records',
          'Actress who played a fierce music mogul on primetime TV',
          'Emmy-winning actress and director who rules behind the camera',
        ],
      },
      {
        id: 'tv-6',
        name: 'Idris Elba',
        image: null,
        imageColor: '#36454F',
        initials: 'IE',
        options: [
          'British actor who played a drug kingpin in Baltimore on HBO',
          'British actor who escaped the Sunken Place in a horror hit',
          'British actor who wielded a lightsaber as a Stormtrooper rebel',
          'British-Nigerian actor who starred in a devastating civil war film',
        ],
      },
      {
        id: 'tv-7',
        name: 'Donald Glover',
        image: null,
        imageColor: '#DAA520',
        initials: 'DG',
        options: [
          'Multi-hyphenate who created Atlanta and raps as Childish Gambino',
          'His Atlanta co-star known for surreal performances and quiet intensity',
          'His Atlanta co-star with a thunderous voice and gentle presence',
          'Cleveland dreamer who put mental health in his hip hop music',
        ],
      },
      {
        id: 'tv-8',
        name: 'Jenna Ortega',
        image: null,
        imageColor: '#1C1C1C',
        initials: 'JO',
        options: [
          'Latina actress who danced her way to fame as Netflix\'s Wednesday',
          'British teen who shaved her head to fight Upside Down monsters',
          'Marvel actress who played a sharp-shooting young Avenger',
          'Young Latina actress who became a new MCU hero named America',
        ],
      },
      {
        id: 'tv-9',
        name: 'Michael B. Jordan',
        image: null,
        imageColor: '#000080',
        initials: 'MJ',
        options: [
          'Actor who stepped into the ring for Creed and lit a kingdom on fire',
          'Wakanda king who said "Wakanda Forever" and inspired millions',
          'Son of a legendary actor who starred in a Christopher Nolan film',
          'Atlanta co-star known for surreal performances and quiet intensity',
        ],
      },
      {
        id: 'tv-10',
        name: 'Tracee Ellis Ross',
        image: null,
        imageColor: '#FF69B4',
        initials: 'TR',
        options: [
          'Daughter of a Motown legend who stars in a beloved family sitcom',
          'Creator-star of an HBO show about being awkward and Black in LA',
          'Scandal fixer who handled Washington\'s crises on primetime TV',
          'Actress and writer who is also the daughter of music royalty',
        ],
      },
    ],
  },

  // ─────────────────────────────────────────────
  // 11. WORLD LANDMARKS (AI-generated images)
  // ─────────────────────────────────────────────
  {
    id: 'landmarks',
    name: 'World Landmarks',
    icon: '🗽',
    color: '#00897B',
    type: 'landmark',
    faces: [
      {
        id: 'lm-1',
        name: 'Eiffel Tower',
        image: require('../../assets/images/landmarks/eiffel-tower.png'),
        imageColor: '#5C4033',
        initials: 'ET',
        options: [
          'Iron lattice tower overlooking Paris since 1889',
          'London clock tower that chimes on the hour',
          'Leaning marble tower in an Italian piazza',
          'World\'s tallest skyscraper rising over the Dubai desert',
        ],
      },
      {
        id: 'lm-2',
        name: 'Great Wall of China',
        image: require('../../assets/images/landmarks/great-wall.png'),
        imageColor: '#8B7355',
        initials: 'GW',
        options: [
          'Ancient stone barrier winding thousands of miles across mountains',
          'Incan citadel hidden high in the Peruvian Andes',
          'Massive temple complex deep in the Cambodian jungle',
          'Rose-red city carved into desert cliffs in Jordan',
        ],
      },
      {
        id: 'lm-3',
        name: 'Statue of Liberty',
        image: require('../../assets/images/landmarks/statue-of-liberty.png'),
        imageColor: '#4A7C59',
        initials: 'SL',
        options: [
          'Green copper lady holding a torch in New York Harbor',
          'Giant stone figure with arms outstretched over Rio de Janeiro',
          'Marble memorial honoring a president who freed the enslaved',
          'Tall stone obelisk on the National Mall in Washington D.C.',
        ],
      },
      {
        id: 'lm-4',
        name: 'Taj Mahal',
        image: require('../../assets/images/landmarks/taj-mahal.png'),
        imageColor: '#F5F5DC',
        initials: 'TM',
        options: [
          'White marble mausoleum built by a heartbroken emperor in India',
          'Lotus-shaped temple welcoming all faiths in New Delhi',
          'Ancient cathedral turned mosque with a massive dome in Istanbul',
          'Blue-tiled mosque facing a grand square in Istanbul',
        ],
      },
      {
        id: 'lm-5',
        name: 'Colosseum',
        image: require('../../assets/images/landmarks/colosseum.png'),
        imageColor: '#C19A6B',
        initials: 'C',
        options: [
          'Ancient Roman arena where gladiators once battled to the roar of 50,000',
          'Greek hilltop temple dedicated to the goddess Athena',
          'Domed Roman temple with an open hole to the sky',
          'Ruins of ancient Roman government buildings and temples',
        ],
      },
      {
        id: 'lm-6',
        name: 'Machu Picchu',
        image: require('../../assets/images/landmarks/machu-picchu.png'),
        imageColor: '#6B8E23',
        initials: 'MP',
        options: [
          'Lost Incan city perched on a misty mountain ridge in Peru',
          'Mayan pyramid with a serpent shadow in Mexico\'s Yucatan',
          'Mysterious giant stone heads on a remote Pacific island',
          'Aztec pyramid of the sun towering over an ancient avenue',
        ],
      },
      {
        id: 'lm-7',
        name: 'Sydney Opera House',
        image: require('../../assets/images/landmarks/sydney-opera-house.png'),
        imageColor: '#F0F0F0',
        initials: 'SO',
        options: [
          'White shell-roofed concert hall on an Australian harbor',
          'Swooping silver concert hall designed by Frank Gehry in LA',
          'Spiraling white museum on Fifth Avenue in New York City',
          'Glass pyramid entrance to the world\'s most famous art museum',
        ],
      },
      {
        id: 'lm-8',
        name: 'Big Ben',
        image: require('../../assets/images/landmarks/big-ben.png'),
        imageColor: '#B8860B',
        initials: 'BB',
        options: [
          'Gothic clock tower standing watch over London\'s Parliament',
          'Iron lattice tower that has overlooked Paris since 1889',
          'Art Deco skyscraper that defined the New York City skyline',
          'Concrete observation tower rising above Toronto\'s waterfront',
        ],
      },
      {
        id: 'lm-9',
        name: 'Christ the Redeemer',
        image: require('../../assets/images/landmarks/christ-redeemer.png'),
        imageColor: '#D3D3D3',
        initials: 'CR',
        options: [
          'Giant stone figure with arms outstretched high above Rio',
          'Green copper lady holding a torch in New York Harbor',
          'Massive Soviet-era statue of a woman raising a sword in Russia',
          'Towering golden Buddha overlooking a temple in China',
        ],
      },
      {
        id: 'lm-10',
        name: 'Golden Gate Bridge',
        image: require('../../assets/images/landmarks/golden-gate.png'),
        imageColor: '#C0392B',
        initials: 'GG',
        options: [
          'Iconic red suspension bridge stretching across San Francisco Bay',
          'Historic stone-and-steel bridge connecting Brooklyn and Manhattan',
          'Twin-towered bridge that lifts open over the River Thames in London',
          'Steel arch bridge framing the Sydney Opera House in Australia',
        ],
      },
    ],
  },

  // ─────────────────────────────────────────────
  // 12. WHAT'S HAPPENING? (AI-generated scenes)
  // ─────────────────────────────────────────────
  {
    id: 'whats-happening',
    name: "What's Happening?",
    icon: '🤔',
    color: '#FF9800',
    type: 'scene',
    faces: [
      {
        id: 'wh-1',
        name: 'Man Riding a Bike',
        image: require('../../assets/images/whats-happening/man-on-bike.png'),
        imageColor: '#3498DB',
        initials: '🚲',
        options: [
          'Someone pedaling on two wheels down the street',
          'Someone sprinting on foot at full speed',
          'Someone standing on a kick scooter and gliding along',
          'Someone rolling on four wheels doing a kickflip',
        ],
      },
      {
        id: 'wh-2',
        name: 'Woman Jumping',
        image: require('../../assets/images/whats-happening/woman-jumping.png'),
        imageColor: '#E67E22',
        initials: '🏃‍♀️',
        options: [
          'A woman leaping into the air with pure joy',
          'A woman moving to the rhythm on a dance floor',
          'A woman sprinting at full speed on a track',
          'A woman bending and reaching in a yoga pose',
        ],
      },
      {
        id: 'wh-3',
        name: 'Kid Flying a Kite',
        image: require('../../assets/images/whats-happening/kid-kite.png'),
        imageColor: '#2ECC71',
        initials: '🪁',
        options: [
          'A child sending something colorful soaring high on a string',
          'A child chasing winged insects through a meadow with a net',
          'A child running around with friends in a game of chase',
          'A child blowing soapy spheres that float away in the wind',
        ],
      },
      {
        id: 'wh-4',
        name: 'Dog Catching a Frisbee',
        image: require('../../assets/images/whats-happening/dog-frisbee.png'),
        imageColor: '#8E44AD',
        initials: '🐕',
        options: [
          'A pup leaping to snag a flying disc out of the air',
          'A pup chasing after a bouncing round toy in a park',
          'A pup paddling through water to retrieve something',
          'A pup soaring over a set of agility course obstacles',
        ],
      },
      {
        id: 'wh-5',
        name: 'Couple Dancing in Rain',
        image: require('../../assets/images/whats-happening/dancing-rain.png'),
        imageColor: '#2C3E50',
        initials: '💃',
        options: [
          'Two people moving together romantically as water falls from the sky',
          'Two people strolling hand in hand along the ocean shore',
          'Two people swaying together at a loud outdoor music event',
          'Two people sharing food on a blanket in a sunny park',
        ],
      },
      {
        id: 'wh-6',
        name: 'Person Skateboarding',
        image: require('../../assets/images/whats-happening/skateboarding.png'),
        imageColor: '#E74C3C',
        initials: '🛹',
        options: [
          'Someone doing tricks on a board with four small wheels',
          'Someone riding waves standing on a board in the ocean',
          'Someone carving down a snowy slope on a board',
          'Someone gliding on inline wheels down a smooth path',
        ],
      },
      {
        id: 'wh-7',
        name: 'Chef Tossing Pizza Dough',
        image: require('../../assets/images/whats-happening/pizza-toss.png'),
        imageColor: '#F39C12',
        initials: '🍕',
        options: [
          'A cook spinning a round disc of dough high into the air',
          'A cook flipping a flat breakfast cake on a hot griddle',
          'A cook rapidly slicing vegetables with a sharp knife',
          'A cook carefully piping frosting onto a layered dessert',
        ],
      },
      {
        id: 'wh-8',
        name: 'Person Reading in Hammock',
        image: require('../../assets/images/whats-happening/hammock-reading.png'),
        imageColor: '#1ABC9C',
        initials: '📖',
        options: [
          'Someone relaxing with a book in a hanging fabric bed',
          'Someone napping peacefully in a swinging cloth between trees',
          'Someone casting a line into the water from a wooden platform',
          'Someone creating art on a canvas in the great outdoors',
        ],
      },
      {
        id: 'wh-9',
        name: 'Street Musician Playing',
        image: require('../../assets/images/whats-happening/street-musician.png'),
        imageColor: '#9B59B6',
        initials: '🎷',
        options: [
          'Someone playing a brass instrument for passersby on the sidewalk',
          'Someone creating art with spray paint on a wall for a crowd',
          'Someone doing breakdance moves on cardboard for tips',
          'Someone performing card tricks and illusions for a gathering',
        ],
      },
      {
        id: 'wh-10',
        name: 'Kids Having a Snowball Fight',
        image: require('../../assets/images/whats-happening/snowball-fight.png'),
        imageColor: '#BDC3C7',
        initials: '❄️',
        options: [
          'Children throwing packed balls of snow at each other',
          'Children stacking three round shapes into a frozen figure',
          'Children racing down a snowy hill on sleds at full speed',
          'Children lying on their backs waving arms in fresh powder',
        ],
      },
    ],
  },

  // ─────────────────────────────────────────────
  // 13. EVERYDAY OBJECTS (AI-generated)
  // ─────────────────────────────────────────────
  {
    id: 'everyday-objects',
    name: 'Everyday Objects',
    icon: '👟',
    color: '#795548',
    type: 'object',
    faces: [
      {
        id: 'eo-1',
        name: 'Red Sneakers',
        image: require('../../assets/images/everyday-objects/red-sneakers.png'),
        imageColor: '#E74C3C',
        initials: '👟',
        options: [
          'Bright canvas kicks made for walking city streets in style',
          'Rugged lace-up footwear built for mountain trails',
          'Satin slippers with ribbons made for dancing on pointe',
          'Leather boots with pointed toes and a Western heel',
        ],
      },
      {
        id: 'eo-2',
        name: 'Vintage Typewriter',
        image: require('../../assets/images/everyday-objects/typewriter.png'),
        imageColor: '#34495E',
        initials: '⌨️',
        options: [
          'Mechanical writing machine with round keys that go clack-clack',
          'Wooden box with dials and an antenna that played broadcasts',
          'Turntable device that spins black vinyl discs to play music',
          'Handheld communication device with a circular numbered dial',
        ],
      },
      {
        id: 'eo-3',
        name: 'Stack of Pancakes',
        image: require('../../assets/images/everyday-objects/pancakes.png'),
        imageColor: '#D4A574',
        initials: '🥞',
        options: [
          'A tower of fluffy golden breakfast cakes dripping with syrup',
          'A tower of crispy grid-patterned breakfast cakes with butter',
          'Thick slices of egg-soaked bread cooked golden on a griddle',
          'Thin French breakfast wraps rolled up with sweet fillings',
        ],
      },
      {
        id: 'eo-4',
        name: 'Acoustic Guitar',
        image: require('../../assets/images/everyday-objects/guitar.png'),
        imageColor: '#8B4513',
        initials: '🎸',
        options: [
          'Hollow-body wooden instrument with six steel strings and a sound hole',
          'Solid-body instrument with pickups, an amp, and a whammy bar',
          'Tiny four-stringed Hawaiian instrument perfect for beach songs',
          'Four-stringed instrument played with a bow under the chin',
        ],
      },
      {
        id: 'eo-5',
        name: 'Old Rotary Phone',
        image: require('../../assets/images/everyday-objects/rotary-phone.png'),
        imageColor: '#16A085',
        initials: '☎️',
        options: [
          'A heavy telephone with a spinning numbered dial and curly cord',
          'A mechanical writing machine with round keys that go clack-clack',
          'A tall wooden clock with a swinging pendulum and hourly chimes',
          'A horn-shaped music player that amplifies sound from a needle',
        ],
      },
      {
        id: 'eo-6',
        name: 'Hot Air Balloon',
        image: require('../../assets/images/everyday-objects/hot-air-balloon.png'),
        imageColor: '#3498DB',
        initials: '🎈',
        options: [
          'A colorful fabric envelope floating in the sky with a wicker basket',
          'A flying machine with spinning blades on top for vertical flight',
          'A giant cigar-shaped airship drifting slowly through the clouds',
          'A V-shaped wing you run off a cliff with and ride the thermals',
        ],
      },
      {
        id: 'eo-7',
        name: 'Polaroid Camera',
        image: require('../../assets/images/everyday-objects/polaroid-camera.png'),
        imageColor: '#F5F5F5',
        initials: '📸',
        options: [
          'Boxy instant camera that spits out a self-developing photo',
          'Classic 35mm camera that shoots onto a roll of film negatives',
          'Cheap plastic camera you use once and then turn in for prints',
          'Modern mirrorless camera with a screen and interchangeable lenses',
        ],
      },
      {
        id: 'eo-8',
        name: 'Disco Ball',
        image: require('../../assets/images/everyday-objects/disco-ball.png'),
        imageColor: '#C0C0C0',
        initials: '🪩',
        options: [
          'A mirrored sphere that scatters light beams across a dance floor',
          'An elegant hanging light fixture dripping with crystal prisms',
          'A round model of the Earth showing continents and oceans',
          'A glass sphere with a miniature winter scene that snows when shaken',
        ],
      },
      {
        id: 'eo-9',
        name: 'Yellow School Bus',
        image: require('../../assets/images/everyday-objects/school-bus.png'),
        imageColor: '#F1C40F',
        initials: '🚌',
        options: [
          'Bright yellow ride that picks kids up every weekday morning',
          'Big red emergency vehicle with a ladder and a siren on top',
          'A jingly truck that drives through neighborhoods playing music',
          'A tall red vehicle with two levels of passenger seating',
        ],
      },
      {
        id: 'eo-10',
        name: "Rubik's Cube",
        image: require('../../assets/images/everyday-objects/rubiks-cube.png'),
        imageColor: '#E74C3C',
        initials: '🧩',
        options: [
          'Twistable six-sided puzzle with nine colored squares on each face',
          'A mysterious wooden box with hidden compartments and mechanisms',
          'A fortune-telling toy sphere you shake and flip for an answer',
          'Colorful interlocking plastic bricks for building anything',
        ],
      },
    ],
  },
];

/**
 * Get all category metadata (for the picker).
 */
export function getCategoryList() {
  return categories.map(({ id, name, icon, color }) => ({ id, name, icon, color }));
}

/**
 * Get faces for a specific category.
 */
export function getFacesByCategory(categoryId) {
  const cat = categories.find((c) => c.id === categoryId);
  return cat ? cat.faces : [];
}

/**
 * Get faces across ALL categories (for "All Categories" mode).
 */
export function getAllFaces() {
  return categories.flatMap((c) => c.faces);
}

/**
 * Get a random selection of faces from a category (or all).
 * @param {string|null} categoryId — null for all categories
 * @param {number} count — how many faces to pick
 */
export function getRandomFaces(categoryId, count = 10) {
  const pool = categoryId ? getFacesByCategory(categoryId) : getAllFaces();
  const shuffled = [...pool].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count);
}

export default categories;
