/**
 * Category data for Squint.
 * 10 cultural categories, each with 10 famous faces.
 *
 * IMAGE SETUP:
 * Each entry has an `image` field for a photo URL and a fallback `imageColor`/`initials`.
 * To add real photos:
 *   1. Drop images into assets/images/ and use: image: require('../../assets/images/drake.jpg')
 *   2. Or point to a CDN: image: 'https://your-cdn.com/images/drake.jpg'
 * The ZoomImage component handles both local (require) and remote (uri string) images,
 * falling back to the colored initials block when image is null.
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
        options: ['Drake', 'Kendrick Lamar', 'J. Cole', 'Future'],
      },
      {
        id: 'hh-2',
        name: 'Jay-Z',
        image: null,
        imageColor: '#1C1C1C',
        initials: 'JZ',
        options: ['Jay-Z', 'Nas', 'Diddy', 'Kanye West'],
      },
      {
        id: 'hh-3',
        name: 'Kendrick Lamar',
        image: null,
        imageColor: '#4A0E0E',
        initials: 'KL',
        options: ['Kendrick Lamar', 'J. Cole', 'Drake', 'Tyler, The Creator'],
      },
      {
        id: 'hh-4',
        name: 'Nicki Minaj',
        image: null,
        imageColor: '#FF69B4',
        initials: 'NM',
        options: ['Nicki Minaj', 'Cardi B', 'Megan Thee Stallion', 'Lil Kim'],
      },
      {
        id: 'hh-5',
        name: 'Kanye West',
        image: null,
        imageColor: '#8B4513',
        initials: 'KW',
        options: ['Kanye West', 'Jay-Z', 'Kid Cudi', 'Pharrell Williams'],
      },
      {
        id: 'hh-6',
        name: 'Lil Wayne',
        image: null,
        imageColor: '#B22222',
        initials: 'LW',
        options: ['Lil Wayne', 'Birdman', 'T.I.', '2 Chainz'],
      },
      {
        id: 'hh-7',
        name: 'Cardi B',
        image: null,
        imageColor: '#DC143C',
        initials: 'CB',
        options: ['Cardi B', 'Nicki Minaj', 'Megan Thee Stallion', 'Doja Cat'],
      },
      {
        id: 'hh-8',
        name: 'Travis Scott',
        image: null,
        imageColor: '#4B3621',
        initials: 'TS',
        options: ['Travis Scott', 'Kid Cudi', 'Don Toliver', 'Playboi Carti'],
      },
      {
        id: 'hh-9',
        name: 'Snoop Dogg',
        image: null,
        imageColor: '#228B22',
        initials: 'SD',
        options: ['Snoop Dogg', 'Dr. Dre', 'Ice Cube', 'Warren G'],
      },
      {
        id: 'hh-10',
        name: 'Megan Thee Stallion',
        image: null,
        imageColor: '#FF6347',
        initials: 'MS',
        options: ['Megan Thee Stallion', 'Cardi B', 'Doja Cat', 'GloRilla'],
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
        options: ['Taylor Swift', 'Ariana Grande', 'Selena Gomez', 'Katy Perry'],
      },
      {
        id: 'ps-2',
        name: 'Ariana Grande',
        image: null,
        imageColor: '#DDA0DD',
        initials: 'AG',
        options: ['Ariana Grande', 'Taylor Swift', 'Dua Lipa', 'Camila Cabello'],
      },
      {
        id: 'ps-3',
        name: 'Billie Eilish',
        image: null,
        imageColor: '#32CD32',
        initials: 'BE',
        options: ['Billie Eilish', 'Olivia Rodrigo', 'Halsey', 'Lorde'],
      },
      {
        id: 'ps-4',
        name: 'Ed Sheeran',
        image: null,
        imageColor: '#FF8C00',
        initials: 'ES',
        options: ['Ed Sheeran', 'Sam Smith', 'Lewis Capaldi', 'Shawn Mendes'],
      },
      {
        id: 'ps-5',
        name: 'Justin Bieber',
        image: null,
        imageColor: '#9370DB',
        initials: 'JB',
        options: ['Justin Bieber', 'Shawn Mendes', 'Charlie Puth', 'Harry Styles'],
      },
      {
        id: 'ps-6',
        name: 'Lady Gaga',
        image: null,
        imageColor: '#C71585',
        initials: 'LG',
        options: ['Lady Gaga', 'Madonna', 'Katy Perry', 'P!nk'],
      },
      {
        id: 'ps-7',
        name: 'Harry Styles',
        image: null,
        imageColor: '#4169E1',
        initials: 'HS',
        options: ['Harry Styles', 'Niall Horan', 'Zayn Malik', 'Louis Tomlinson'],
      },
      {
        id: 'ps-8',
        name: 'Dua Lipa',
        image: null,
        imageColor: '#FF1493',
        initials: 'DL',
        options: ['Dua Lipa', 'Ariana Grande', 'Billie Eilish', 'Doja Cat'],
      },
      {
        id: 'ps-9',
        name: 'The Weeknd',
        image: null,
        imageColor: '#8B0000',
        initials: 'TW',
        options: ['The Weeknd', 'Bruno Mars', 'Post Malone', 'Khalid'],
      },
      {
        id: 'ps-10',
        name: 'Olivia Rodrigo',
        image: null,
        imageColor: '#8A2BE2',
        initials: 'OR',
        options: ['Olivia Rodrigo', 'Billie Eilish', 'Sabrina Carpenter', 'Madison Beer'],
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
        options: ['Oprah Winfrey', 'Whoopi Goldberg', 'Gayle King', 'Ellen DeGeneres'],
      },
      {
        id: 'iw-2',
        name: 'Michelle Obama',
        image: null,
        imageColor: '#4682B4',
        initials: 'MO',
        options: ['Michelle Obama', 'Kamala Harris', 'Condoleezza Rice', 'Jill Biden'],
      },
      {
        id: 'iw-3',
        name: 'Serena Williams',
        image: null,
        imageColor: '#6A0DAD',
        initials: 'SW',
        options: ['Serena Williams', 'Venus Williams', 'Naomi Osaka', 'Simone Biles'],
      },
      {
        id: 'iw-4',
        name: 'Beyoncé',
        image: null,
        imageColor: '#C8A415',
        initials: 'B',
        options: ['Beyoncé', 'Rihanna', 'Alicia Keys', 'Mary J. Blige'],
      },
      {
        id: 'iw-5',
        name: 'Kamala Harris',
        image: null,
        imageColor: '#191970',
        initials: 'KH',
        options: ['Kamala Harris', 'Michelle Obama', 'Hillary Clinton', 'Nancy Pelosi'],
      },
      {
        id: 'iw-6',
        name: 'Viola Davis',
        image: null,
        imageColor: '#800020',
        initials: 'VD',
        options: ['Viola Davis', 'Taraji P. Henson', 'Lupita Nyong\'o', 'Angela Bassett'],
      },
      {
        id: 'iw-7',
        name: 'Simone Biles',
        image: null,
        imageColor: '#FF4500',
        initials: 'SB',
        options: ['Simone Biles', 'Gabby Douglas', 'Aly Raisman', 'Sunisa Lee'],
      },
      {
        id: 'iw-8',
        name: 'Dolly Parton',
        image: null,
        imageColor: '#FFB6C1',
        initials: 'DP',
        options: ['Dolly Parton', 'Loretta Lynn', 'Reba McEntire', 'Carrie Underwood'],
      },
      {
        id: 'iw-9',
        name: 'Ruth Bader Ginsburg',
        image: null,
        imageColor: '#2F4F4F',
        initials: 'RBG',
        options: ['Ruth Bader Ginsburg', 'Sonia Sotomayor', 'Sandra Day O\'Connor', 'Elena Kagan'],
      },
      {
        id: 'iw-10',
        name: 'Maya Angelou',
        image: null,
        imageColor: '#8B4513',
        initials: 'MA',
        options: ['Maya Angelou', 'Toni Morrison', 'Alice Walker', 'Zora Neale Hurston'],
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
        options: ['Michael Jordan', 'LeBron James', 'Kobe Bryant', 'Magic Johnson'],
      },
      {
        id: 'nba-2',
        name: 'LeBron James',
        image: null,
        imageColor: '#4B0082',
        initials: 'LJ',
        options: ['LeBron James', 'Michael Jordan', 'Kevin Durant', 'Giannis Antetokounmpo'],
      },
      {
        id: 'nba-3',
        name: 'Kobe Bryant',
        image: null,
        imageColor: '#FFD700',
        initials: 'KB',
        options: ['Kobe Bryant', 'Michael Jordan', 'Tracy McGrady', 'Allen Iverson'],
      },
      {
        id: 'nba-4',
        name: 'Stephen Curry',
        image: null,
        imageColor: '#1E90FF',
        initials: 'SC',
        options: ['Stephen Curry', 'Klay Thompson', 'Chris Paul', 'Russell Westbrook'],
      },
      {
        id: 'nba-5',
        name: 'Magic Johnson',
        image: null,
        imageColor: '#DAA520',
        initials: 'MJ',
        options: ['Magic Johnson', 'Larry Bird', 'Kareem Abdul-Jabbar', 'Isiah Thomas'],
      },
      {
        id: 'nba-6',
        name: 'Shaquille O\'Neal',
        image: null,
        imageColor: '#000080',
        initials: 'SO',
        options: ['Shaquille O\'Neal', 'Hakeem Olajuwon', 'Patrick Ewing', 'Dwight Howard'],
      },
      {
        id: 'nba-7',
        name: 'Kevin Durant',
        image: null,
        imageColor: '#FF4500',
        initials: 'KD',
        options: ['Kevin Durant', 'LeBron James', 'Kawhi Leonard', 'Paul George'],
      },
      {
        id: 'nba-8',
        name: 'Allen Iverson',
        image: null,
        imageColor: '#8B0000',
        initials: 'AI',
        options: ['Allen Iverson', 'Derrick Rose', 'Steve Nash', 'Jason Kidd'],
      },
      {
        id: 'nba-9',
        name: 'Tim Duncan',
        image: null,
        imageColor: '#2F2F2F',
        initials: 'TD',
        options: ['Tim Duncan', 'Kevin Garnett', 'Dirk Nowitzki', 'Karl Malone'],
      },
      {
        id: 'nba-10',
        name: 'Wilt Chamberlain',
        image: null,
        imageColor: '#4B0082',
        initials: 'WC',
        options: ['Wilt Chamberlain', 'Bill Russell', 'Kareem Abdul-Jabbar', 'Oscar Robertson'],
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
        options: ['Denzel Washington', 'Will Smith', 'Samuel L. Jackson', 'Morgan Freeman'],
      },
      {
        id: 'hw-2',
        name: 'Leonardo DiCaprio',
        image: null,
        imageColor: '#2E8B57',
        initials: 'LD',
        options: ['Leonardo DiCaprio', 'Brad Pitt', 'Matt Damon', 'Tom Cruise'],
      },
      {
        id: 'hw-3',
        name: 'Meryl Streep',
        image: null,
        imageColor: '#708090',
        initials: 'MS',
        options: ['Meryl Streep', 'Cate Blanchett', 'Judi Dench', 'Helen Mirren'],
      },
      {
        id: 'hw-4',
        name: 'Will Smith',
        image: null,
        imageColor: '#4169E1',
        initials: 'WS',
        options: ['Will Smith', 'Denzel Washington', 'Martin Lawrence', 'Jamie Foxx'],
      },
      {
        id: 'hw-5',
        name: 'Scarlett Johansson',
        image: null,
        imageColor: '#DC143C',
        initials: 'SJ',
        options: ['Scarlett Johansson', 'Jennifer Lawrence', 'Margot Robbie', 'Emma Stone'],
      },
      {
        id: 'hw-6',
        name: 'Samuel L. Jackson',
        image: null,
        imageColor: '#6A0DAD',
        initials: 'SJ',
        options: ['Samuel L. Jackson', 'Morgan Freeman', 'Laurence Fishburne', 'Idris Elba'],
      },
      {
        id: 'hw-7',
        name: 'Jennifer Aniston',
        image: null,
        imageColor: '#F4A460',
        initials: 'JA',
        options: ['Jennifer Aniston', 'Courteney Cox', 'Reese Witherspoon', 'Julia Roberts'],
      },
      {
        id: 'hw-8',
        name: 'Brad Pitt',
        image: null,
        imageColor: '#D2B48C',
        initials: 'BP',
        options: ['Brad Pitt', 'Leonardo DiCaprio', 'George Clooney', 'Matt Damon'],
      },
      {
        id: 'hw-9',
        name: 'Zendaya',
        image: null,
        imageColor: '#FF4081',
        initials: 'Z',
        options: ['Zendaya', 'Halle Bailey', 'Amandla Stenberg', 'Yara Shahidi'],
      },
      {
        id: 'hw-10',
        name: 'Morgan Freeman',
        image: null,
        imageColor: '#3E2723',
        initials: 'MF',
        options: ['Morgan Freeman', 'Samuel L. Jackson', 'Denzel Washington', 'James Earl Jones'],
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
        options: ['Rihanna', 'Beyoncé', 'SZA', 'Jhené Aiko'],
      },
      {
        id: 'rb-2',
        name: 'Usher',
        image: null,
        imageColor: '#4A4A4A',
        initials: 'U',
        options: ['Usher', 'Chris Brown', 'Ne-Yo', 'Trey Songz'],
      },
      {
        id: 'rb-3',
        name: 'Alicia Keys',
        image: null,
        imageColor: '#B8860B',
        initials: 'AK',
        options: ['Alicia Keys', 'Beyoncé', 'Mary J. Blige', 'Lauryn Hill'],
      },
      {
        id: 'rb-4',
        name: 'Frank Ocean',
        image: null,
        imageColor: '#FF8C00',
        initials: 'FO',
        options: ['Frank Ocean', 'The Weeknd', 'Daniel Caesar', 'Miguel'],
      },
      {
        id: 'rb-5',
        name: 'SZA',
        image: null,
        imageColor: '#8FBC8F',
        initials: 'S',
        options: ['SZA', 'Jhené Aiko', 'Summer Walker', 'H.E.R.'],
      },
      {
        id: 'rb-6',
        name: 'Mariah Carey',
        image: null,
        imageColor: '#FFB6C1',
        initials: 'MC',
        options: ['Mariah Carey', 'Whitney Houston', 'Celine Dion', 'Christina Aguilera'],
      },
      {
        id: 'rb-7',
        name: 'Chris Brown',
        image: null,
        imageColor: '#CD853F',
        initials: 'CB',
        options: ['Chris Brown', 'Usher', 'Trey Songz', 'Omarion'],
      },
      {
        id: 'rb-8',
        name: 'Lauryn Hill',
        image: null,
        imageColor: '#556B2F',
        initials: 'LH',
        options: ['Lauryn Hill', 'Erykah Badu', 'India.Arie', 'Jill Scott'],
      },
      {
        id: 'rb-9',
        name: 'Toni Braxton',
        image: null,
        imageColor: '#800080',
        initials: 'TB',
        options: ['Toni Braxton', 'Mariah Carey', 'TLC', 'Brandy'],
      },
      {
        id: 'rb-10',
        name: 'H.E.R.',
        image: null,
        imageColor: '#696969',
        initials: 'H',
        options: ['H.E.R.', 'SZA', 'Summer Walker', 'Kehlani'],
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
        options: ['Barack Obama', 'Denzel Washington', 'Will Smith', 'Jamie Foxx'],
      },
      {
        id: 'wl-2',
        name: 'Nelson Mandela',
        image: null,
        imageColor: '#228B22',
        initials: 'NM',
        options: ['Nelson Mandela', 'Desmond Tutu', 'Kofi Annan', 'Morgan Freeman'],
      },
      {
        id: 'wl-3',
        name: 'Martin Luther King Jr.',
        image: null,
        imageColor: '#2F4F4F',
        initials: 'MLK',
        options: ['Martin Luther King Jr.', 'Malcolm X', 'John Lewis', 'Frederick Douglass'],
      },
      {
        id: 'wl-4',
        name: 'Queen Elizabeth II',
        image: null,
        imageColor: '#4169E1',
        initials: 'QE',
        options: ['Queen Elizabeth II', 'Princess Diana', 'Margaret Thatcher', 'Queen Victoria'],
      },
      {
        id: 'wl-5',
        name: 'Abraham Lincoln',
        image: null,
        imageColor: '#1C1C1C',
        initials: 'AL',
        options: ['Abraham Lincoln', 'George Washington', 'Thomas Jefferson', 'Theodore Roosevelt'],
      },
      {
        id: 'wl-6',
        name: 'John F. Kennedy',
        image: null,
        imageColor: '#4682B4',
        initials: 'JFK',
        options: ['John F. Kennedy', 'Richard Nixon', 'Ronald Reagan', 'Bill Clinton'],
      },
      {
        id: 'wl-7',
        name: 'Mahatma Gandhi',
        image: null,
        imageColor: '#F5F5DC',
        initials: 'MG',
        options: ['Mahatma Gandhi', 'Jawaharlal Nehru', 'Dalai Lama', 'Nelson Mandela'],
      },
      {
        id: 'wl-8',
        name: 'Malala Yousafzai',
        image: null,
        imageColor: '#FF1493',
        initials: 'MY',
        options: ['Malala Yousafzai', 'Greta Thunberg', 'Emma Watson', 'Yara Shahidi'],
      },
      {
        id: 'wl-9',
        name: 'Winston Churchill',
        image: null,
        imageColor: '#3B3B3B',
        initials: 'WC',
        options: ['Winston Churchill', 'Franklin Roosevelt', 'Dwight Eisenhower', 'Charles de Gaulle'],
      },
      {
        id: 'wl-10',
        name: 'Angela Merkel',
        image: null,
        imageColor: '#B0C4DE',
        initials: 'AM',
        options: ['Angela Merkel', 'Theresa May', 'Hillary Clinton', 'Christine Lagarde'],
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
        options: ['Elon Musk', 'Jeff Bezos', 'Mark Zuckerberg', 'Bill Gates'],
      },
      {
        id: 'tt-2',
        name: 'Jeff Bezos',
        image: null,
        imageColor: '#FF9900',
        initials: 'JB',
        options: ['Jeff Bezos', 'Elon Musk', 'Larry Page', 'Tim Cook'],
      },
      {
        id: 'tt-3',
        name: 'Bill Gates',
        image: null,
        imageColor: '#00A4EF',
        initials: 'BG',
        options: ['Bill Gates', 'Steve Jobs', 'Mark Zuckerberg', 'Paul Allen'],
      },
      {
        id: 'tt-4',
        name: 'Mark Zuckerberg',
        image: null,
        imageColor: '#4267B2',
        initials: 'MZ',
        options: ['Mark Zuckerberg', 'Jack Dorsey', 'Evan Spiegel', 'Kevin Systrom'],
      },
      {
        id: 'tt-5',
        name: 'Steve Jobs',
        image: null,
        imageColor: '#555555',
        initials: 'SJ',
        options: ['Steve Jobs', 'Bill Gates', 'Tim Cook', 'Jony Ive'],
      },
      {
        id: 'tt-6',
        name: 'Tim Cook',
        image: null,
        imageColor: '#A3AAAE',
        initials: 'TC',
        options: ['Tim Cook', 'Steve Jobs', 'Sundar Pichai', 'Satya Nadella'],
      },
      {
        id: 'tt-7',
        name: 'Sundar Pichai',
        image: null,
        imageColor: '#4285F4',
        initials: 'SP',
        options: ['Sundar Pichai', 'Satya Nadella', 'Tim Cook', 'Larry Page'],
      },
      {
        id: 'tt-8',
        name: 'Jensen Huang',
        image: null,
        imageColor: '#76B900',
        initials: 'JH',
        options: ['Jensen Huang', 'Lisa Su', 'Pat Gelsinger', 'Satya Nadella'],
      },
      {
        id: 'tt-9',
        name: 'Satya Nadella',
        image: null,
        imageColor: '#00A4EF',
        initials: 'SN',
        options: ['Satya Nadella', 'Sundar Pichai', 'Tim Cook', 'Andy Jassy'],
      },
      {
        id: 'tt-10',
        name: 'Lisa Su',
        image: null,
        imageColor: '#ED1C24',
        initials: 'LS',
        options: ['Lisa Su', 'Jensen Huang', 'Sheryl Sandberg', 'Susan Wojcicki'],
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
        options: ['Tom Brady', 'Peyton Manning', 'Aaron Rodgers', 'Patrick Mahomes'],
      },
      {
        id: 'sg-2',
        name: 'Usain Bolt',
        image: null,
        imageColor: '#FFD700',
        initials: 'UB',
        options: ['Usain Bolt', 'Carl Lewis', 'Tyson Gay', 'Justin Gatlin'],
      },
      {
        id: 'sg-3',
        name: 'Lionel Messi',
        image: null,
        imageColor: '#75AADB',
        initials: 'LM',
        options: ['Lionel Messi', 'Cristiano Ronaldo', 'Neymar Jr.', 'Kylian Mbappé'],
      },
      {
        id: 'sg-4',
        name: 'Muhammad Ali',
        image: null,
        imageColor: '#8B0000',
        initials: 'MA',
        options: ['Muhammad Ali', 'Mike Tyson', 'Floyd Mayweather', 'Joe Frazier'],
      },
      {
        id: 'sg-5',
        name: 'Tiger Woods',
        image: null,
        imageColor: '#006400',
        initials: 'TW',
        options: ['Tiger Woods', 'Jack Nicklaus', 'Phil Mickelson', 'Arnold Palmer'],
      },
      {
        id: 'sg-6',
        name: 'Cristiano Ronaldo',
        image: null,
        imageColor: '#006633',
        initials: 'CR',
        options: ['Cristiano Ronaldo', 'Lionel Messi', 'Neymar Jr.', 'Zlatan Ibrahimovic'],
      },
      {
        id: 'sg-7',
        name: 'Wayne Gretzky',
        image: null,
        imageColor: '#041E42',
        initials: 'WG',
        options: ['Wayne Gretzky', 'Mario Lemieux', 'Sidney Crosby', 'Bobby Orr'],
      },
      {
        id: 'sg-8',
        name: 'Michael Phelps',
        image: null,
        imageColor: '#1E90FF',
        initials: 'MP',
        options: ['Michael Phelps', 'Ryan Lochte', 'Mark Spitz', 'Ian Thorpe'],
      },
      {
        id: 'sg-9',
        name: 'Patrick Mahomes',
        image: null,
        imageColor: '#E31837',
        initials: 'PM',
        options: ['Patrick Mahomes', 'Josh Allen', 'Tom Brady', 'Lamar Jackson'],
      },
      {
        id: 'sg-10',
        name: 'Sha\'Carri Richardson',
        image: null,
        imageColor: '#FF6347',
        initials: 'SR',
        options: ['Sha\'Carri Richardson', 'Florence Griffith Joyner', 'Shelly-Ann Fraser-Pryce', 'Allyson Felix'],
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
        options: ['Pedro Pascal', 'Oscar Isaac', 'Diego Luna', 'Javier Bardem'],
      },
      {
        id: 'tv-2',
        name: 'Issa Rae',
        image: null,
        imageColor: '#FF7F50',
        initials: 'IR',
        options: ['Issa Rae', 'Tracee Ellis Ross', 'Yvonne Orji', 'Marsai Martin'],
      },
      {
        id: 'tv-3',
        name: 'Millie Bobby Brown',
        image: null,
        imageColor: '#FF1493',
        initials: 'MB',
        options: ['Millie Bobby Brown', 'Sadie Sink', 'Jenna Ortega', 'Florence Pugh'],
      },
      {
        id: 'tv-4',
        name: 'Sterling K. Brown',
        image: null,
        imageColor: '#2F4F4F',
        initials: 'SB',
        options: ['Sterling K. Brown', 'Mahershala Ali', 'Brian Tyree Henry', 'Jonathan Majors'],
      },
      {
        id: 'tv-5',
        name: 'Kerry Washington',
        image: null,
        imageColor: '#9932CC',
        initials: 'KW',
        options: ['Kerry Washington', 'Viola Davis', 'Taraji P. Henson', 'Regina King'],
      },
      {
        id: 'tv-6',
        name: 'Idris Elba',
        image: null,
        imageColor: '#36454F',
        initials: 'IE',
        options: ['Idris Elba', 'Daniel Kaluuya', 'John Boyega', 'Chiwetel Ejiofor'],
      },
      {
        id: 'tv-7',
        name: 'Donald Glover',
        image: null,
        imageColor: '#DAA520',
        initials: 'DG',
        options: ['Donald Glover', 'Lakeith Stanfield', 'Brian Tyree Henry', 'Kid Cudi'],
      },
      {
        id: 'tv-8',
        name: 'Jenna Ortega',
        image: null,
        imageColor: '#1C1C1C',
        initials: 'JO',
        options: ['Jenna Ortega', 'Millie Bobby Brown', 'Hailee Steinfeld', 'Xochitl Gomez'],
      },
      {
        id: 'tv-9',
        name: 'Michael B. Jordan',
        image: null,
        imageColor: '#000080',
        initials: 'MJ',
        options: ['Michael B. Jordan', 'Chadwick Boseman', 'John David Washington', 'Lakeith Stanfield'],
      },
      {
        id: 'tv-10',
        name: 'Tracee Ellis Ross',
        image: null,
        imageColor: '#FF69B4',
        initials: 'TR',
        options: ['Tracee Ellis Ross', 'Issa Rae', 'Kerry Washington', 'Rashida Jones'],
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
