import { defineCollection, z } from "astro:content";
import { file } from "astro/loaders";

const books = defineCollection({
    loader: file('src/data/books.json'),
    schema: ({image}) => z.object({
        slug: z.string(),
        title: z.string(),
        author: z.string(),
        cover: image(),
        year: z.string().max(4),
        genre: z.enum(["Aliens", "Alternate History", "Apocalyptic", "Cyberpunk", "Dystopian", "Hard Sci-Fi", "Military", "Robots", "Space Opera", "Steampunk", "Time Travel"]),
        rating: z.string(),
        description: z.string(),
        bookshop: z.string().url(),
        goodreads: z.string().url()
    })
})

export const collections = { books };
