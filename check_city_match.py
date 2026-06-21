import csv

# Load cities15000
print('Loading cities15000...')
cities = {}
with open('cities15000.txt', 'r', encoding='utf-8') as f:
    for line in f:
        parts = line.strip().split('\t')
        if len(parts) >= 15:
            name = parts[1].lower()
            ascii_name = parts[2].lower()
            country = parts[8]
            lat = float(parts[4])
            lon = float(parts[5])
            cities[(country, name)] = (lat, lon)
            cities[(country, ascii_name)] = (lat, lon)
            if len(parts) > 3 and parts[3]:
                for alt in parts[3].split(','):
                    alt = alt.strip().lower()
                    if alt:
                        cities[(country, alt)] = (lat, lon)

print(f'Loaded {len(cities)} city entries')

COUNTRY_ISO_MAP = {
    'United States': 'US', 'Japan': 'JP', 'Italy': 'IT', 'France': 'FR',
    'United Kingdom': 'GB', 'Germany': 'DE', 'Turkey': 'TR', 'Netherlands': 'NL',
    'Czech Republic': 'CZ', 'Korea, Republic Of': 'KR', 'Taiwan, Province Of': 'TW',
    'Russian Federation': 'RU', 'Austria': 'AT', 'Israel': 'IL', 'Spain': 'ES',
    'Switzerland': 'CH', 'Sweden': 'SE', 'Canada': 'CA', 'Iran, Islamic Republic': 'IR',
    'India': 'IN', 'Poland': 'PL', 'Australia': 'AU', 'Brazil': 'BR', 'Belgium': 'BE',
    'Viet Nam': 'VN', 'Hong Kong': 'HK', 'Egypt': 'EG', 'Singapore': 'SG',
    'Norway': 'NO', 'Finland': 'FI', 'Denmark': 'DK', 'Greece': 'GR', 'Portugal': 'PT',
    'Ireland': 'IE', 'Mexico': 'MX', 'Thailand': 'TH', 'South Africa': 'ZA',
    'New Zealand': 'NZ', 'Chile': 'CL', 'Colombia': 'CO', 'Argentina': 'AR',
    'Malaysia': 'MY', 'Indonesia': 'ID', 'Philippines': 'PH', 'Romania': 'RO',
    'Hungary': 'HU', 'Ukraine': 'UA', 'Slovakia': 'SK', 'Croatia': 'HR',
    'Bulgaria': 'BG', 'Serbia': 'RS', 'Slovenia': 'SI', 'Lithuania': 'LT',
    'Latvia': 'LV', 'Estonia': 'EE', 'Iceland': 'IS', 'Luxembourg': 'LU',
    'Malta': 'MT', 'Cyprus': 'CY', 'Monaco': 'MC', 'Andorra': 'AD',
    'Liechtenstein': 'LI', 'Moldova, Republic Of': 'MD', 'Albania': 'AL',
    'Montenegro': 'ME', 'Georgia': 'GE', 'Armenia': 'AM', 'Azerbaijan': 'AZ',
    'Kazakhstan': 'KZ', 'Mongolia': 'MN', 'China': 'CN', 'Pakistan': 'PK',
    'Bangladesh': 'BD', 'Nepal': 'NP', 'Afghanistan': 'AF', 'Iraq': 'IQ',
    'Lebanon': 'LB', 'Jordan': 'JO', 'Palestinian, State Of': 'PS',
    'Saudi Arabia': 'SA', 'Kuwait': 'KW', 'Bahrain': 'BH', 'Qatar': 'QA',
    'United Arab Emirates': 'AE', 'Oman': 'OM', 'Yemen': 'YE', 'Morocco': 'MA',
    'Algeria': 'DZ', 'Tunisia': 'TN', 'Libya': 'LY', 'Sudan': 'SD',
    'Ethiopia': 'ET', 'Eritrea': 'ER', 'Djibouti': 'DJ', 'Somalia': 'SO',
    'Kenya': 'KE', 'Uganda': 'UG', 'Tanzania, United Republic Of': 'TZ',
    'Rwanda': 'RW', 'Burundi': 'BI', 'Democratic Republic Of The Congo': 'CD',
    'Congo': 'CG', 'Gabon': 'GA', 'Equatorial Guinea': 'GQ', 'Cameroon': 'CM',
    'Central African Republic': 'CF', 'Chad': 'TD', 'Niger': 'NE', 'Mali': 'ML',
    'Burkina Faso': 'BF', 'Mauritania': 'MR', 'Senegal': 'SN', 'Gambia': 'GM',
    'Guinea-Bissau': 'GW', 'Guinea': 'GN', 'Sierra Leone': 'SL', 'Liberia': 'LR',
    'Ivory Coast': 'CI', 'Ghana': 'GH', 'Togo': 'TG', 'Benin': 'BJ',
    'Nigeria': 'NG', 'Cape Verde': 'CV', 'Sao Tome And Principe': 'ST',
    'Zambia': 'ZM', 'Zimbabwe': 'ZW', 'Malawi': 'MW', 'Mozambique': 'MZ',
    'Madagascar': 'MG', 'Mauritius': 'MU', 'Seychelles': 'SC', 'Comoros': 'KM',
    'Botswana': 'BW', 'Namibia': 'NA', 'Angola': 'AO', 'Lesotho': 'LS',
    'Eswatini': 'SZ', 'Western Sahara': 'EH', 'Antigua And Barbuda': 'AG',
    'Bahamas': 'BS', 'Barbados': 'BB', 'Cuba': 'CU', 'Dominica': 'DM',
    'Dominican Republic': 'DO', 'Grenada': 'GD', 'Haiti': 'HT', 'Jamaica': 'JM',
    'Saint Kitts And Nevis': 'KN', 'Saint Lucia': 'LC',
    'Saint Vincent And The Grenadines': 'VC', 'Trinidad And Tobago': 'TT',
    'Guatemala': 'GT', 'Belize': 'BZ', 'Honduras': 'HN', 'El Salvador': 'SV',
    'Nicaragua': 'NI', 'Costa Rica': 'CR', 'Panama': 'PA',
    'Greenland': 'GL', 'Bermuda': 'BM', 'Cayman Islands': 'KY',
    'Turks And Caicos Islands': 'TC', 'British Virgin Islands': 'VG',
    'Anguilla': 'AI', 'Montserrat': 'MS', 'Guadeloupe': 'GP',
    'Martinique': 'MQ', 'Saint Barthelemy': 'BL', 'Saint Martin': 'MF',
    'Sint Maarten': 'SX', 'Aruba': 'AW', 'Curacao': 'CW', 'Bonaire': 'BQ',
    'Puerto Rico': 'PR', 'US Virgin Islands': 'VI', 'Falkland Islands': 'FK',
    'South Georgia': 'GS', 'French Guiana': 'GF', 'Suriname': 'SR',
    'Guyana': 'GY', 'Venezuela, Bolivaria': 'VE', 'Bolivia, Plurination': 'BO',
    'Paraguay': 'PY', 'Uruguay': 'UY', 'French Polynesia': 'PF',
    'New Caledonia': 'NC', 'Vanuatu': 'VU', 'Solomon Islands': 'SB',
    'Papua New Guinea': 'PG', 'Fiji': 'FJ', 'Samoa': 'WS', 'Tonga': 'TO',
    'Kiribati': 'KI', 'Tuvalu': 'TV', 'Nauru': 'NR', 'Palau': 'PW',
    'Marshall Islands': 'MH', 'Micronesia, Federated States Of': 'FM',
    'Guam': 'GU', 'Northern Mariana Islands': 'MP', 'American Samoa': 'AS',
    'Cook Islands': 'CK', 'Niue': 'NU', 'Tokelau': 'TK', 'Pitcairn': 'PN',
    'Wallis And Futuna': 'WF', 'Norfolk Island': 'NF', 'Christmas Island': 'CX',
    'Cocos Islands': 'CC', 'Heard Island And Mcdonald Islands': 'HM',
    'Aland Islands': 'AX', 'Faroe Islands': 'FO', 'Svalbard And Jan Mayen': 'SJ',
    'Jersey': 'JE', 'Guernsey': 'GG', 'Isle Of Man': 'IM', 'Gibraltar': 'GI',
    'Macao': 'MO', 'Korea, Democratic People\'s Republic Of': 'KP',
    'Timor-Leste': 'TL', 'Brunei Darussalam': 'BN', 'Cambodia': 'KH',
    'Laos': 'LA', 'Myanmar': 'MM', 'Sri Lanka': 'LK', 'Bhutan': 'BT',
    'Maldives': 'MV', 'Syrian Arab Republic': 'SY', 'Bosnia And Herzegovina': 'BA',
    'North Macedonia': 'MK', 'Kosovo': 'XK', 'Uzbekistan': 'UZ',
    'Kyrgyzstan': 'KG', 'Tajikistan': 'TJ', 'Turkmenistan': 'TM',
    'South Sudan': 'SS', 'Saint Helena': 'SH', 'Ascension': 'AC',
    'Tristan Da Cunha': 'TA', 'Bouvet Island': 'BV',
    'French Southern Territories': 'TF', 'Antarctica': 'AQ',
    'Saint Pierre And Miquelon': 'PM', 'Reunion': 'RE', 'Mayotte': 'YT',
}

matched = 0
unmatched = set()
with open('insecam_dump.csv', 'r', encoding='utf-8') as f:
    reader = csv.DictReader(f, delimiter='\t')
    for row in reader:
        city = row.get('city', '').strip().lower()
        country_name = row.get('country', '').strip()
        country_iso = COUNTRY_ISO_MAP.get(country_name, 'XX')
        if not city or city == '-':
            continue
        if (country_iso, city) in cities:
            matched += 1
        else:
            unmatched.add((country_iso, city))

print(f'Matched cities: {matched}')
print(f'Unmatched unique cities: {len(unmatched)}')
total = matched + len(unmatched)
print(f'Match rate: {matched / total * 100:.1f}%')
print('Sample unmatched:', list(unmatched)[:20])
