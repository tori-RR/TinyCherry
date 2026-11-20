package main

import (
	"database/sql"
	"errors"
	"fmt"
	"slices"
)

func orderKeyAt(index int) string {
	return fmt.Sprintf("%020d", index+1)
}

// Moves are applied in request order. A later move may use an earlier moved
// row as its anchor. The caller persists the result only after all moves pass.
func applyOrderMoves(rows []object, idField string, body any) ([]object, error) {
	input := obj(body)
	moves := array(input["moves"])
	if len(input) != 1 || len(moves) == 0 {
		return nil, errors.New("order request requires a non-empty moves array")
	}
	for _, value := range moves {
		move := obj(value)
		id := text(move["id"])
		anchor := obj(move["anchor"])
		if len(move) != 2 || id == "" || len(anchor) != 1 {
			return nil, errors.New("order move requires an ID and one anchor")
		}
		from := slices.IndexFunc(rows, func(row object) bool { return row[idField] == id })
		if from < 0 {
			return nil, sql.ErrNoRows
		}
		moving := rows[from]
		next := make([]object, 0, len(rows))
		next = append(next, rows[:from]...)
		next = append(next, rows[from+1:]...)
		to := -1
		if position, ok := anchor["position"]; ok {
			switch text(position) {
			case "first":
				to = 0
			case "last":
				to = len(next)
			default:
				return nil, errors.New("invalid order move position")
			}
		} else {
			anchorID := text(anchor["before"])
			after, placeAfter := anchor["after"]
			if placeAfter {
				anchorID = text(after)
			}
			if anchorID != "" {
				to = slices.IndexFunc(next, func(row object) bool { return row[idField] == anchorID })
				if to >= 0 && placeAfter {
					to++
				}
			}
		}
		if to < 0 {
			return nil, errors.New("order anchor is missing or references itself")
		}
		rows = slices.Insert(next, to, moving)
	}
	return rows, nil
}
